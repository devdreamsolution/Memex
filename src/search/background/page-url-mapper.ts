import { StorageBackendPlugin } from '@worldbrain/storex'
import { DexieStorageBackend } from '@worldbrain/storex-backend-dexie'

import { Page } from 'src/search'
import { reshapePageForDisplay } from './utils'
import { AnnotPage } from './types'
import { Tweet, User } from 'src/social-integration/types'

export class PageUrlMapperPlugin extends StorageBackendPlugin<
    DexieStorageBackend
> {
    static MAP_OP_ID = 'memex:dexie.mapUrlsToPages'
    static MAP_OP_TWEET = 'memex:dexie.mapUrlsToTweets'

    install(backend: DexieStorageBackend) {
        super.install(backend)

        backend.registerOperation(
            PageUrlMapperPlugin.MAP_OP_ID,
            this.findMatchingPages.bind(this),
        )

        backend.registerOperation(
            PageUrlMapperPlugin.MAP_OP_TWEET,
            this.findMatchingTweets.bind(this),
        )
    }

    private encodeImage = (img: Blob, base64Img?: boolean) =>
        new Promise<string>((resolve, reject) => {
            if (!base64Img) {
                return resolve(URL.createObjectURL(img))
            }

            const reader = new FileReader()
            reader.onerror = reject
            reader.onload = () => resolve(reader.result as string)
            reader.readAsDataURL(img)
        })

    private async lookupPages(
        pageUrls: string[],
        pageMap: Map<string, Page>,
        base64Img?: boolean,
    ) {
        const pages = await this.backend.dexieInstance
            .table('pages')
            .where('url')
            .anyOf(pageUrls)
            .limit(pageUrls.length)
            .toArray()

        return Promise.all(
            pages.map(async page => {
                const screenshot = page.screenshot
                    ? await this.encodeImage(page.screenshot, base64Img)
                    : undefined

                pageMap.set(page.url, {
                    ...page,
                    screenshot,
                    hasBookmark: false, // Set later, if needed
                })
            }),
        )
    }

    private async lookupFavIcons(
        hostnames: string[],
        favIconMap: Map<string, string>,
        base64Img?: boolean,
    ) {
        // Find all assoc. fav-icons and create object URLs pointing to the Blobs
        const favIcons = await this.backend.dexieInstance
            .table('favIcons')
            .where('hostname')
            .anyOf(hostnames)
            .limit(hostnames.length)
            .toArray()

        await Promise.all(
            favIcons.map(async fav =>
                favIconMap.set(
                    fav.hostname,
                    await this.encodeImage(fav.favIcon, base64Img),
                ),
            ),
        )
    }

    private async lookupTweets(
        pageUrls: string[],
        tweetMap: Map<string, Tweet>,
    ) {
        const tweets = await this.backend.dexieInstance
            .table('tweets')
            .where('url')
            .anyOf(pageUrls)
            .limit(pageUrls.length)
            .toArray()

        return Promise.all(
            tweets.map(async tweet => {
                tweetMap.set(tweet.url, {
                    ...tweet,
                    hasBookmark: false,
                })
            }),
        )
    }

    private async lookupUsers(
        userIds: string[],
        userMap: Map<string, User>,
        base64Img?: boolean,
    ) {
        const users = await this.backend.dexieInstance
            .table('users')
            .where('id')
            .anyOf(userIds)
            .limit(userIds.length)
            .toArray()

        return Promise.all(
            users.map(async user => {
                const profilePic = user.profilePic
                    ? await this.encodeImage(user.profilePic, base64Img)
                    : undefined
                userMap.set(user.id, {
                    ...user,
                    profilePic,
                })
            }),
        )
    }

    private async lookupTags(
        pageUrls: string[],
        tagMap: Map<string, string[]>,
    ) {
        const tags = await this.backend.dexieInstance
            .table('tags')
            .where('url')
            .anyOf(pageUrls)
            .primaryKeys()

        tags.forEach(([name, url]) => {
            const current = tagMap.get(url) || []
            tagMap.set(url, [...current, name])
        })
    }

    private async lookupAnnotsCounts(
        pageUrls: string[],
        countMap: Map<string, number>,
    ) {
        const annotUrls = (await this.backend.dexieInstance
            .table('annotations')
            .where('pageUrl')
            .anyOf(pageUrls)
            .keys()) as string[]

        annotUrls.forEach(url => {
            const count = countMap.get(url) || 0
            countMap.set(url, count + 1)
        })
    }

    private async lookupLatestTimes(
        pageUrls: string[],
        timeMap: Map<string, number>,
        pageMap: Map<string, Page>,
        upperTimeBound: number,
    ) {
        const visitQueryP = this.backend.dexieInstance
            .table('visits')
            .where('url')
            .anyOf(pageUrls)
            .primaryKeys()
        const bmQueryP = this.backend.dexieInstance
            .table('bookmarks')
            .where('url')
            .anyOf(pageUrls)
            .limit(pageUrls.length)
            .toArray()

        const [visits, bms] = await Promise.all([visitQueryP, bmQueryP])

        const visitMap = new Map<string, number>()
        for (const [time, url] of visits) {
            if (upperTimeBound && time > upperTimeBound) {
                continue
            }

            // For urls with lots of visits, IDB sorts them latest last
            visitMap.set(url, time)
        }

        const bookmarkMap = new Map<string, number>()
        for (const { time, url } of bms) {
            const page = pageMap.get(url)
            pageMap.set(url, { ...page, hasBookmark: true } as any)

            if (upperTimeBound && time > upperTimeBound) {
                continue
            }

            bookmarkMap.set(url, time)
        }

        for (const url of pageUrls) {
            const visit = visitMap.get(url)
            const bm = bookmarkMap.get(url)

            const max = !bm || bm < visit ? visit : bm
            timeMap.set(url, max)
        }
    }

    /**
     * Goes through given input, finding all matching pages from the DB.
     * Then does further lookups to determine whether each matching page
     * has an associated bookmark and fav-icon.
     */
    async findMatchingPages(
        pageUrls: string[],
        {
            base64Img,
            upperTimeBound,
            latestTimes,
        }: {
            base64Img?: boolean
            upperTimeBound?: number
            /**
             * If defined, it should be the same length as main input `pageUrls`, containing the latest times
             * to use for each result. This allows us to skip the lookup
             * (old page search involves this lookup already for scoring).
             */
            latestTimes?: number[]
        },
    ): Promise<AnnotPage[]> {
        if (!pageUrls.length) {
            return []
        }

        const favIconMap = new Map<string, string>()
        const pageMap = new Map<string, Page>()
        const tagMap = new Map<string, string[]>()
        const countMap = new Map<string, number>()
        const timeMap = new Map<string, number>()

        // Run the first set of queries to get display data
        await Promise.all([
            this.lookupPages(pageUrls, pageMap, base64Img),
            this.lookupTags(pageUrls, tagMap),
            this.lookupAnnotsCounts(pageUrls, countMap),
        ])

        const hostnames = new Set(
            [...pageMap.values()].map(page => page.hostname),
        )

        // Run the subsequent set of queries that depend on earlier results
        await Promise.all([
            latestTimes
                ? Promise.resolve()
                : this.lookupLatestTimes(
                      pageUrls,
                      timeMap,
                      pageMap,
                      upperTimeBound,
                  ),
            this.lookupFavIcons([...hostnames], favIconMap, base64Img),
        ])

        // Map page results back to original input
        return pageUrls
            .map((url, i) => {
                const page = pageMap.get(url)

                // Data integrity issue; no matching page in the DB. Fail nicely
                if (!page || !page.url) {
                    return null
                }

                return {
                    ...page,
                    favIcon: favIconMap.get(page.hostname),
                    tags: tagMap.get(url) || [],
                    annotsCount: countMap.get(url),
                    displayTime: latestTimes
                        ? latestTimes[i]
                        : timeMap.get(url),
                }
            })
            .filter(page => page != null)
            .map(reshapePageForDisplay)
    }

    async findMatchingTweets(
        tweetUrls: string[],
        {
            base64Img,
            upperTimeBound,
            latestTimes,
        }: {
            base64Img?: boolean
            upperTimeBound?: number
            latestTimes?: number[]
        },
    ): Promise<Tweet[]> {
        const tweetMap = new Map<string, Tweet>()
        const countMap = new Map<string, number>()
        const tagMap = new Map<string, string[]>()
        const userMap = new Map<string, User>()

        // Run the first set of queries to get display data
        await Promise.all([
            this.lookupTweets(tweetUrls, tweetMap),
            this.lookupTags(tweetUrls, tagMap),
            this.lookupAnnotsCounts(tweetUrls, countMap),
        ])

        const userIds = new Set(
            [...tweetMap.values()].map(tweet => tweet.userId),
        )

        await this.lookupUsers([...userIds], userMap, base64Img)

        // Map page results back to original input
        return tweetUrls
            .map((url, i) => {
                const tweet = tweetMap.get(url)

                // Data integrity issue; no matching page in the DB. Fail nicely
                if (!tweet) {
                    return null
                }

                return {
                    ...tweet,
                    user: userMap.get(tweet.userId),
                    displayTime: new Date(tweet.createdWhen).getTime(),
                    tags: tagMap.get(url) || [],
                    annotsCount: countMap.get(url),
                }
            })
            .filter(tweet => tweet !== null)
    }
}
