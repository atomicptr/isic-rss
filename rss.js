const FeedParser = require("feedparser")
const {Readable} = require("stream")

module.exports = function(bot) {
    function identify(article) {
        let ident = article.guid || article.link
        return bot.hash(ident)
    }

    function getArticles(res, siteId) {
        let promise = new Promise(function(resolve, reject) {
            res.globalCollection("sites").findOne({_id: siteId}).then(site => {
                if(!site) {
                    return reject({message: `Unknown site id: ${siteId}`})
                }

                // TODO: delete old articles
                bot.request(site.link, (err, response, body) => {
                    if(err) {
                        bot.error(`ERR: error with connection to ${site.link}`)
                        return reject(err)
                    }

                    let feedparser = new FeedParser()

                    feedparser._articles = []

                    feedparser.on("error", err => {
                        bot.error(`ERR: error with connection to ${site.link}`)
                        return reject(err)
                    })

                    feedparser.on("readable", function() {
                        let article = null

                        while(article = this.read()) {
                            this._articles.push(article)
                        }
                    })

                    feedparser.on("end", function() {
                        bot.debug(`${this._articles.length} articles found on ${site.link}`)

                        let articles = []

                        for(let article of this._articles) {
                            const articleIdentifier = identify(article)

                            let articleMetaImage = article.meta ? article.meta.image : false

                            let dbarticle = {
                                ident: articleIdentifier,
                                url: article.link,
                                title: article.title,
                                timestamp: article.pubdate || article.date || new Date().getTime(),
                                image: articleMetaImage
                            }

                            articles.push(dbarticle)

                            res.globalCollection("sites").update(
                                {_id: siteId, "articles.ident": {$ne: articleIdentifier}},
                                {$push: {articles: dbarticle}}
                            )
                        }

                        resolve(articles)
                    })

                    // convert string into stream
                    let bodyStream = new Readable()
                    bodyStream.push(body)
                    bodyStream.push(null)

                    bodyStream.pipe(feedparser)
                })
            }).catch(err => reject(err))
        })

        promise.catch(err => bot.error(err))

        return promise
    }

    bot.respond(/rss add\s+(https?:\/\/[^\s]+)$/im, res => {
        let url = res.matches[1]

        if(!bot.isServerAdministrator(res.server, res.author)) {
            res.reply("I'm sorry but you don't have the permission to do that.")
            return
        }

        let collectionPromises = [
            res.collection("rss-channels").updateOne(
                {channelId: res.channelId}, {
                    $set: {channelId: res.channelId},
                    $setOnInsert: {sites: [], processedArticles: []}
                },
                {upsert: true}
            ),
            res.globalCollection("sites").updateOne(
                {link: url}, {
                    $set: {link: url},
                    $setOnInsert: {articles: []}
                },
                {upsert: true}
            )
        ]

        Promise.all(collectionPromises).then(_ => {
            res.collection("rss-channels").findOne({channelId: res.channelId}).then(channel => {
                res.globalCollection("sites").findOne({link: url}).then(site => {
                    if(channel.sites.indexOf(site._id) < 0) {
                        getArticles(res, site._id).then(articles => {
                            res.collection("rss-channels").update({channelId: res.channelId}, {
                                $addToSet: {
                                    sites: site._id,
                                    processedArticles: {$each: site.articles.concat(articles).map(article => article.ident)}
                                }
                            })

                            res.send(`Added ${url} to my list, ${articles.length} articles omitted.`)
                        })
                    } else {
                        res.reply(`${site.link} is already on my list.`)
                    }
                })
            })
        }).catch(err => bot.error(err))
    })

    // @BOT rss remove URL
    bot.respond(/rss remove\s+(https?:\/\/[^\s]+)$/im, res => {
        let url = res.matches[1]

        if(!bot.isServerAdministrator(res.server, res.author)) {
            res.reply("I'm sorry but you don't have the permission to do that.")
            return
        }

        res.globalCollection("sites").findOne({link: url}).then(site => {
            if(!site) {
                res.send("I didn't knew that site anyway ¯\\_(ツ)_/¯")
                return
            }

            res.collection("rss-channels").update(
                {channelId: res.channelId},
                {$pull: {sites: site._id}}
            ).then(_ => {
                res.send(`Removed ${url} from my list.`)
            }).catch(err => bot.error(err))
        })
    })

    bot.respond(/rss list/i, res => {
        res.collection("rss-channels").findOne({channelId: res.channelId}).then(channel => {
            if(!channel) {
                res.send("No RSS feeds registered in this channel :(")
                return
            }

            res.globalCollection("sites").find({_id: {$in: channel.sites}}).toArray().then(sites => {
                let list = sites.map(site => site.link)
                res.send(`Here is a list of all my feeds for this channel:\n\n${list.join("\n")}`)
            })
        })
    })

    bot.interval("isic-rss-check", res => {
        bot.log("checking rss feeds...")

        // collect all site ids, find sites that no one is using and remove them
        function getAllUsedSites(callback) {
            res.eachCollection("rss-channels").then(collections => {
                let promises = collections.map(col => col.find({}).toArray())

                Promise.all(promises).then(channels => {
                    let allChannels = [].concat.apply([], channels)

                    callback([].concat.apply([], allChannels.map(ch => ch.sites)).filter((elem, index, $this) => index === $this.indexOf(elem)))
                })
            })
        }

        getAllUsedSites(sites => {
            res.globalCollection("sites").find({_id: {$nin: sites}}).toArray().then(toBeDeletedSites => {
                if(toBeDeletedSites.length === 0) {
                    bot.debug(`No unused rss feeds found :)`)
                    return
                }

                let trash = [].concat.apply([], toBeDeletedSites.map(s => s.articles)).map(a => a.ident)

                bot.debug(`${toBeDeletedSites.length} rss feeds with ${trash.length} articles will be removed...`)

                res.eachCollection("rss-channels", collection => {
                    collection.update({processedArticles: {$in: trash}}, {$pull: {processedArticles: {$in: trash}}})
                })

                res.globalCollection("sites").remove({_id: {$nin: sites}})
            })
        })

        res.globalCollection("sites").find({}).toArray().then(sites => {
            let promises = sites.map(site => getArticles(res, site._id))

            Promise.all(promises).then(_ => {
                res.eachCollection("rss-channels", collection => {
                    collection.find({}).toArray().then(channels => {
                        channels.forEach(channel => {
                            res.globalCollection("sites").find({_id: {$in: channel.sites}}).toArray().then(sites => {
                                let allArticles = [].concat.apply([], sites.map(site => site.articles))
                                let newArticles = allArticles.filter(article => channel.processedArticles.indexOf(article.ident) === -1)

                                newArticles.forEach(article => {
                                    bot.sendMessageToChannel(bot.client.channels.get(channel.channelId), `:mailbox_with_mail: ${article.title} ${article.url}`).then(_ => {
                                        collection.update({_id: channel._id}, {$addToSet: {processedArticles: article.ident}})
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    })
}
