const FeedParser = require("feedparser")
const Readable = require("stream").Readable

module.exports = function(bot) {
    function getArticles(link, callback) {
        bot.request(link, (err, response, body) => {
            if(err) {
                console.error(`ERR: error with connection to ${link}: ${err.name} ${err.message}`)
                console.error(err)
                return []
            }

            let feedparser = new FeedParser()

            feedparser._articles = []

            feedparser.on("error", err => {
                console.error(`ERR: error with connection to ${link}: ${err.name} ${err.message}`)
                console.error(err)
            })

            feedparser.on("readable", function() {
                let article = null

                while(article = this.read()) {
                    this._articles.push(article)
                }
            })

            feedparser.on("end", function() {
                console.log(`${this._articles.length} articles found on ${link}`)
                callback(this._articles)
            })

            // convert string into stream
            let bodyStream = new Readable()
            bodyStream._read = function() {}
            bodyStream.push(body)
            bodyStream.push(null)

            bodyStream.pipe(feedparser)
        })
    }

    function identify(article) {
        let ident = article.guid || article.link
        return bot.hash(ident)
    }

    function setupDb(handle) {
        bot.db(handle).defaults({
            isicRssChannelLinks: {},
            isicRssUrlNames: {}
        }).value()
    }

    // @BOT rss add URL
    bot.respond(/rss add\s+(https?:\/\/[^\s]+)$/im, res => {
        setupDb(res)

        let url = res.matches[1]

        if(!bot.isServerAdministrator(res.server, res.author)) {
            res.reply("I'm sorry but you don't have the permission to do that.")
            return
        }

        getArticles(url, articles => {
            for(let article of articles) {
                let ident = identify(article)

                bot.db(res).set(`isicRssChannelLinks.${res.channelId}.${bot.hash(url)}.${ident}`, true).value()
                bot.db(res).set(`isicRssUrlNames.${bot.hash(url)}`, url).value()
            }

            res.send(`Added ${url} to my list, ${articles.length} articles omitted.`)
        })
    })

    // @BOT rss remove URL
    bot.respond(/rss remove\s+(https?:\/\/[^\s]+)$/im, res => {
        setupDb(res)

        let url = res.matches[1]

        if(!bot.isServerAdministrator(res.server, res.author)) {
            res.reply("I'm sorry but you don't have the permission to do that.")
            return
        }

        let state = bot.db(res).getState()
        delete state.isicRssChannelLinks[res.channelId][bot.hash(url)]
        bot.db(res).setState(state)

        res.send(`Removed ${url} from my list.`)
    })

    bot.respond(/rss list/i, res => {
        setupDb(res)

        let sites = bot.db(res).get(`isicRssChannelLinks.${res.channelId}`).value()
        let names = bot.db(res).get(`isicRssUrlNames`).value()

        let list = Object.keys(sites).map(hash => `* ${names[hash]}`)

        res.send(`Here is a list of all my feeds for this channel:\n\n${list.join("\n")}`)
    })

    bot.interval("isic-rss-check", _ => {
        console.log("checking rss feeds...")

        let servers = bot.servers

        function checkArticles(dbHandle) {
            setupDb(dbHandle)

            let channels = bot.db(dbHandle).get("isicRssChannelLinks").value()
            let urlNames = bot.db(dbHandle).get("isicRssUrlNames").value()

            for(let channelId of Object.keys(channels)) {
                for(let siteHash of Object.keys(channels[channelId])) {
                    let hack = (channelId, articleList) => {
                        return function(articles) {
                            let cache = {}

                            // mark new articles as unread
                            for(let article of articles) {
                                let ident = identify(article)

                                cache[ident] = article

                                let knownArticle = channels[channelId][siteHash][ident] || false

                                if(!knownArticle) {
                                    bot.db(dbHandle).set(`isicRssChannelLinks.${channelId}.${siteHash}.${ident}`, false).value()
                                }
                            }

                            for(let ident of Object.keys(articleList)) {
                                let alreadyVisited = articleList[ident]
                                if(!alreadyVisited && cache[ident]) {
                                    let title = cache[ident].title || ""
                                    let url = cache[ident].link || ""

                                    bot.sendMessageToChannel(bot.client.channels.get(channelId), `:mailbox_with_mail: ${title} ${url}`).then(message => {
                                        bot.db(dbHandle).set(`isicRssChannelLinks.${channelId}.${siteHash}.${ident}`, true).value()
                                    })
                                }
                            }
                        }
                    }

                    if(siteHash && urlNames[siteHash])
                        getArticles(urlNames[siteHash], hack(channelId, channels[channelId][siteHash]))
                }
            }
        }

        for(let server of servers) {
            checkArticles(server)
        }

        bot.forEveryUserWithDatabase(user => {if(user) checkArticles(user)})
    })
}
