import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'
import { parsePath, withQuery } from 'ufo'

const SOCIAL_BOTS = [
  'applebot',
  'discordbot',
  'facebot',
  'facebookexternalhit',
  'linkedinbot',
  'linkexpanding',
  'mastodon',
  'skypeuripreview',
  'slackbot',
  'slackbot-linkexpanding',
  'snapchat',
  'telegrambot',
  'tiktok',
  'twitterbot',
  'whatsapp',
]

function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return SOCIAL_BOTS.some(bot => ua.includes(bot))
}

function getDeviceRedirectUrl(userAgent: string, link: z.infer<typeof LinkSchema>): string | null {
  if (!link.apple && !link.google)
    return null

  const ua = userAgent.toLowerCase()

  if (link.google && ua.includes('android')) {
    return link.google
  }

  if (link.apple && (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod'))) {
    return link.apple
  }

  return null
}

function hasOgConfig(link: z.infer<typeof LinkSchema>): boolean {
  return !!(link.title || link.image)
}

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, ''))
  const { slugRegex, reserveSlug } = useAppConfig()
  const { homeURL, linkCacheTtl, caseSensitive, redirectStatusCode } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    const { KV } = cloudflare.env

    let link: z.infer<typeof LinkSchema> | null = null

    const getLink = async (key: string) =>
      await KV.get(`link:${key}`, { type: 'json', cacheTtl: linkCacheTtl })

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(caseSensitive ? slug : lowerCaseSlug)

    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(slug)
    }

    if (link) {
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      const userAgent = getHeader(event, 'user-agent') || ''
      const query = getQuery(event)
      
      // 【修改点 1】强制使用 withQuery，不再判断 redirectWithQuery 开关
      const buildTarget = (url: string) => withQuery(url, query)

      const deviceRedirectUrl = getDeviceRedirectUrl(userAgent, link)
      if (deviceRedirectUrl) {
        // 【修改点 2】对设备专用跳转（如手机应用商店地址）也应用参数拼接
        return sendRedirect(event, buildTarget(deviceRedirectUrl), +redirectStatusCode)
      }

      if (isSocialBot(userAgent) && hasOgConfig(link)) {
        const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
        const html = generateOgHtml(link, buildTarget(link.url), baseUrl)
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        return html
      }

      // 最终重定向应用参数拼接
      return sendRedirect(event, buildTarget(link.url), +redirectStatusCode)
    }
  }
})
