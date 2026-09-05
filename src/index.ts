import { Context, Schema, Session, h } from 'koishi'
import { Readable } from 'node:stream'
import crypto from 'crypto'
import { pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import { BottleContent, CommentContent, webBottle, type WebBottleData } from './webBottle'
import {
  buildAuxiliaryMessage,
  buildCloudBottleMessages,
  buildCommentSelectionText,
  buildHistoryBundle,
  buildLocalBottleMessages,
  buildLogBundle,
  buildMainMenuBundle,
  buildPendingSubmissionReceipt,
  buildPreReviewAdminBundle,
  buildPreReviewNotifyPrompt,
  buildPreReviewResultPush,
  buildPreReviewWithdrawListText,
  buildRejectReasonPrompt,
  buildReportAdminBundle,
  buildStatisticsBundle,
  buildSubmissionSummary,
  buildThrowBottlePrompt,
  buildThrowBottleResultMessage,
  sendBottleBundle,
  PRE_REVIEW_NOTIFY_VALUE,
  REJECT_REASON_SKIP_VALUE,
  THROW_BOTTLE_CANCEL_VALUE,
  THROW_BOTTLE_SKIP_IMAGE_VALUE,
  THROW_BOTTLE_SKIP_TITLE_VALUE,
  type AssetTransformer,
  type ImageDataLoader,
  type BottleStatistics,
  type LogDisplayItem,
  type PendingSubmissionLike,
} from './message'
import { BottleReportRegistry, type ReportScope } from './report'
import { isPreReviewRequired, PendingSubmissionRegistry, type PendingSubmissionRecord } from './pre-review'
import { sendProactivePrivateMessage } from './proactive-message'
import { createAdapterDisplayNameResolver, withAdapterDisplayNames, withoutAdapterDisplayNames, type KoishiUserDatabase } from './user-name'
import { setupConsole, type ConsoleGlue } from './console'
import { isConsoleOperator, type PanelChangeAction } from './console-service'

export const name = 'smmcat-driftbottle'

interface LocalStorageService {
  basePath: string
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

declare module 'koishi' {
  interface Context {
    localstorage: LocalStorageService
  }
}

export interface Config {
  adminQQ: Array<string>
  uapisApiKey?: string
  uapisCacheMinutes?: number
  basePath: string
  dataPath: string
  autoCorrectionPath: boolean
  deBug: boolean
  historyPath: string
  logsPath: string
  throwWaitTime: number
  scoopWaitTime: number
  leaveMsgWaitTime: number
  logsNum: number
  isExamine: boolean
  Appid: string
  key: string
  delOrBlur: any
  filter: Array<string>
  textfilter: Array<string>
  allowDelOfAuthor: boolean,
  reportThreshold: number
  webFilingPath: string
}

export const inject = {
  required: ['localstorage'],
  optional: ['assets', 'database'],
}

/** 数据变更广播中心：QQ 端操作与控制台面板操作都从这里通知面板刷新 */
const changeListeners = new Set<(action: PanelChangeAction) => void>()
let notifyPanelError = (error: unknown) => console.error(error)
function notifyPanelChange(action: PanelChangeAction) {
  for (const listener of changeListeners) {
    try {
      listener(action)
    } catch (error) {
      notifyPanelError(error)
    }
  }
}

export const usage = `
漂流瓶业务，需要安装 [localstorage](/market?keyword=smmcat-localstorage) 服务，作为数据的存储策略

若你需要腾讯不良内容审核业务，请 [加群申请](https://qm.qq.com/q/YpjTRzg3M4) appid
`

export const Config: Schema<Config> = Schema.object({
  adminQQ: Schema.array(String).role('table').description('管理员用户 ID；QQ 平台请填写 adapter-qq-crack 提供的用户 OpenID（session.userId），可用于审核、删除及接收举报主动私信'),
  uapisApiKey: Schema.string().role('secret').default('').description('可选的 Uapis API Key，填写后使用 Bearer 鉴权查询纯数字 QQ ID 昵称'),
  uapisCacheMinutes: Schema.number().min(0).step(1).default(60).description('Uapis QQ 昵称缓存时长（分钟），设为 0 可禁用缓存'),
  autoCorrectionPath: Schema.boolean().default(true).description('自动矫正多媒体文件存放位置'),
  basePath: Schema.string().default('./data/smm-driftbottle').description('多媒体文件存放位置'),
  dataPath: Schema.string().default('smm-driftbottle').description('用户数据命名空间 (在 /data/localstorage 文件夹下)'),
  historyPath: Schema.string().default('smm-driftbottle-history').description('用户获得瓶子的数据命名空间 (在 /data/localstorage 文件夹下)'),
  logsPath: Schema.string().default('smmcat-driftbottle-logs').description('用户日志的数据命名空间 (在 /data/localstorage 文件夹下)'),
  webFilingPath: Schema.string().default('smmcat-driftbottle-upload').description('用户上传到服务器的数据命名空间 (在 /data/localstorage 文件夹下)'),
  allowDelOfAuthor: Schema.boolean().default(true).description('允许漂流瓶的作者删除瓶子下的评论'),
  reportThreshold: Schema.number().step(1).min(1).default(3).description('同一漂流瓶达到该举报数量后，主动通知管理员 QQ 审核'),
  logsNum: Schema.number().default(20).description('日志最大显示数量'),
  throwWaitTime: Schema.number().default(20000).description('扔漂流瓶的等待时间'),
  scoopWaitTime: Schema.number().default(20000).description('捞漂流瓶的等待时间'),
  leaveMsgWaitTime: Schema.number().default(20000).description('留言的等待时间'),
  deBug: Schema.boolean().default(false).description('日志查看信息'),
  isExamine: Schema.boolean().default(false).description('是否开启不良内容审核'),
  Appid: Schema.string().description('不良内容审核的 appid'),
  key: Schema.string().description('不良内容审核的 密钥'),
  delOrBlur: Schema.union([
    Schema.const(0).description('拒收'),
    Schema.const(1).description('高斯模糊'),
  ]).description('不良图片处理逻辑'),
  filter: Schema.array(String).role('table').default([
    "ACGPorn",
    'ButtocksExposed',
    "WomenSexyChest",
    'WomenSexy',
    'ACGSexy',
    "SexualGoods",
    "Porn",
    "PornSum",
    "Sexy"
  ]).description('图像要检测的词条'),
  textfilter: Schema.array(String).role("table").default([
    "Abuse",
    "Illegal",
    "Spam",
    "Terror",
    "Porn",
    "Polity",
    "Ad"
  ]).description("文本要检测的词条")
})

export type HistoryInfoList = {
  userId: string,
  id: number,
  type: '图文瓶' | '图片瓶' | '文本瓶' | '语音瓶'
  username?: string
}
export  /** 漂流瓶内容 */
  type DiftContent = {
    /** 创建时间 */
    creatTime: number,
    /** 文本 */
    text: string | null,
    /** 图片 */
    image: string[] | null,
    /** 发送者 */
    userId?: string,
    /** 发送者名字 */
    username?: string,
    /** 是否删除 */
    isDel?: boolean
  }

/** 漂流瓶信息 */
export type DiftInfo = {
  /** 瓶子编号 */
  id: number,
  /** 样式风格 */
  style: number,
  /** 内容 */
  content: DiftContent & {
    /** 音频 */
    audio: string[] | null,
    /** 标题 */
    title: string | null,
  },
  /** 被捞次数 */
  getCount: number,
  /** 允许显示 */
  show: boolean,
  /** 发送者 */
  userId: string,
  username?: string,
  /** 评论 */
  review: DiftContent[]
}
export function apply(ctx: Context, config: Config) {

  // 面板广播兜底日志走 koishi logger，避免裸 console 输出
  notifyPanelError = (error) => ctx.logger(name).warn('漂流瓶面板刷新广播失败: %o', error)



  /** 下载工具集合 */
  const downloadUilts = {
    /** 基地址 */
    basePath: path.join(ctx.baseDir, config.basePath),
    /** 下载音频到本地 */
    async setStoreForAudio(audioUrl: string, type = 'silk'): Promise<string | null> {
      const setPath = path.join(this.basePath, './audio')
      if (!fs.existsSync(setPath)) {
        fs.mkdirSync(setPath, { recursive: true });
      }
      const timestamp = new Date().getTime();
      const audioPath = path.join(setPath, `${timestamp}.${type}`);
      const response = await ctx.http.get(audioUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(audioPath);
      const responseNodeStream = Readable.fromWeb(response)
      responseNodeStream.pipe(writer);

      return await new Promise((resolve, reject) => {
        writer.on('finish', () => {
          config.deBug && console.log(`下载完成，文件路径 ${audioPath}`);
          resolve(pathToFileURL(audioPath).href)
        });
        writer.on('error', () => {
          reject(null)
        });
      });
    },
    /** 下载图片到本地 */
    async setStoreForImage(imageUrl: string, type = 'jpg'): Promise<string | null> {
      const setPath = path.join(this.basePath, './image')
      if (!fs.existsSync(setPath)) {
        fs.mkdirSync(setPath, { recursive: true });
      }
      const timestamp = new Date().getTime();
      const imagePath = path.join(setPath, `${timestamp}.${type}`);
      const response = await ctx.http.get(imageUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(imagePath);
      const responseNodeStream = Readable.fromWeb(response)
      responseNodeStream.pipe(writer);

      return await new Promise((resolve, reject) => {
        writer.on('finish', () => {
          config.deBug && console.log(`下载完成，文件路径 ${imagePath}`);
          resolve(pathToFileURL(imagePath).href)
        });
        writer.on('error', () => {
          reject(null)
        });
      });
    }
  }

  const tools = {
    sanitizeText(input) {
      // 清除 <script> 标签及其内容
      const scriptRemoved = input?.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      // 清除所有其他 HTML 标签
      const cleanText = scriptRemoved?.replace(/<[^>]*>/g, '');
      return cleanText?.trim(); // 去除首尾空格
    }
  }

  enum UseType {
    /** 扔瓶子 */
    RenPingZi = 0,
    /** 捞瓶子 */
    LaoPingZi = 1,
    /** 留言 */
    LiuYan = 2
  }
  const timeList = [config.throwWaitTime, config.scoopWaitTime, config.leaveMsgWaitTime]
  // 指令冷却
  const cooling = {
    userIdList: {},
    check(userId: string, type: UseType): [boolean, number] {
      if (!this.userIdList[userId]) {
        this.userIdList[userId] = { 0: 0, 1: 0, 2: 0 }
      }
      const now = +new Date()
      if (now - this.userIdList[userId][type] < timeList[type]) {
        const needTime = timeList[type] - (now - this.userIdList[userId][type])
        return [false, needTime]
      } else {
        this.userIdList[userId][type] = now
        return [true, 0]
      }
    }
  }

  enum logType {
    /** 用户发布瓶子 */
    FABU = 0,
    /** 用户捞瓶子 */
    HUOQU = 1,
    /** 用户主动留言 */
    LIUYAN = 2,
    /** 用户被留言 */
    BEILIUYAN = 3,
    /** 用户瓶子被获得 */
    BEIHUOQU = 4,
    /** 瓶子被管理员封禁 */
    SHANCHU = 5,
    /** 瓶子被管理员解封 */
    JIEFENG = 6,
    /** 评论被封禁 */
    PLFENGJIN = 7,
    /** 待审投稿被管理员驳回 */
    BOHUI = 8
  }

  /** 日志项信息 */
  type logItem = {
    /** 事件类型 */
    type: logType,
    /** 目标用户 id */
    userId: string,
    /** 瓶子 id */
    bottleId: number,
    /** 瓶子类型 */
    bottleType?: string,
    /** 事件时间 */
    time?: number,
    /** 是否被用户查看 */
    isNew?: boolean,
    /** 附加说明（如驳回理由），仅作者日志与订阅推送可见 */
    reason?: string
  }



  /** 日志记录业务 */
  const logs = {
    basePath: '',
    userIdList: {},
    async init() {
      this.basePath = path.join(ctx.localstorage.basePath, config.logsPath)
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
      const dict = { ok: 0, err: 0 }
      const temp: { [key: string]: logItem[] } = {}
      const eventList = fs.readdirSync(this.basePath).map((item) => {
        return new Promise(async (resolve, rejects) => {
          try {
            const localData = JSON.parse(await ctx.localstorage.getItem(`${config.logsPath}/${item}`))
            temp[item] = localData
            dict.ok++
            resolve(true)
          } catch (error) {
            console.log(error);
            dict.err++
            resolve(true)
          }
        })
      })
      await Promise.all(eventList)
      this.userIdList = temp
      config.deBug && console.log(`用户日志加载完成，一共加载成功${dict.ok}个用户数据，失败:${dict.err}个`);
    },
    /** 添加事件
     * @param userId 存储事件的目标
     * @param info 事件信息
     */
    addLogForEvent(userId: string, info: logItem) {
      const temp = {
        type: info.type,
        userId: info.userId,
        bottleId: info.bottleId,
        time: +new Date(),
        bottleType: info.bottleType || '漂流瓶',
        isNew: true,
        ...(info.reason ? { reason: info.reason } : {})
      }
      this.initUserLogsData(userId)
      this.userIdList[userId].unshift(temp)

      // 本地记录日志最大数量 默认 30条
      if (this.userIdList[userId].length > (config.logsNum > 30 ? config.logsNum : 30)) {
        this.userIdList[userId] = this.userIdList[userId].slice(0, config.logsNum > 30 ? config.logsNum : 30)
      }

      this.updateLogsStore(userId)
    },
    /** 获取用户日志信息 */
    async getUserLogsList(session: Session) {
      try {
        this.initUserLogsData(session.userId)
        const items = this.userIdList[session.userId]
          .slice(0, config.logsNum)
          .filter((item: logItem) => item)
          .map((item: logItem) => logs.formatTypeEvent(session.userId, item))

        if (items.some((item: LogDisplayItem) => item.isNew)) {
          this.userIdList[session.userId].forEach((item: logItem) => {
            item.isNew = false
          })
          await this.updateLogsStore(session.userId)
        }

        await sendBottleBundle(session, buildLogBundle(items, session.platform))
      } catch (error) {
        config.deBug && console.log(error)
        await session.send('获取漂流瓶日志失败，请稍后重试。')
      }
    },
    /** 格式化日志事件信息 */
    formatTypeEvent(userId: string, logItem: logItem): LogDisplayItem {
      const temp: LogDisplayItem = {
        time: logItem.time || 0,
        isNew: Boolean(logItem.isNew),
        info: '',
      }
      switch (logItem.type) {
        case logType.FABU:
          temp.info = '你向海中扔出了一个 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType
          break
        case logType.HUOQU:
          temp.info = '你在海中捞到了 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType
          break
        case logType.LIUYAN:
          temp.info = '你向 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '写了留言'
          break
        case logType.BEILIUYAN:
          temp.info = logItem.userId + ' 向你 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '写了留言'
          break
        case logType.BEIHUOQU:
          temp.info = '你的 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '被 ' + logItem.userId + ' 首次捞到'
          break
        case logType.SHANCHU:
          temp.info = '你 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '被管理员 ' + logItem.userId + ' 封禁'
          break
        case logType.JIEFENG:
          temp.info = '你 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '被管理员 ' + logItem.userId + ' 解封'
          break
        case logType.PLFENGJIN:
          temp.info = '你在 ID 为 ' + logItem.bottleId + ' 的 ' + logItem.bottleType + '中的一条留言被' +
            (config.adminQQ.includes(logItem.userId) || isConsoleOperator(logItem.userId) ? '管理员 ' : '瓶子作者 ') + logItem.userId + ' 屏蔽'
          break
        case logType.BOHUI:
          temp.info = '你的待审投稿（编号 ' + logItem.bottleId + '）被管理员 ' + logItem.userId + ' 驳回' +
            (logItem.reason ? '，理由：' + logItem.reason : '')
          break
        default:
          temp.info = '发生了一些不为人知的事情，无从考究'
          break
      }
      return temp
    },
    /** 初始化用户数据 */
    initUserLogsData(userId: string) {
      if (!this.userIdList[userId]) {
        this.userIdList[userId] = []
      }
    },
    /** 更新本地数据 */
    async updateLogsStore(userId: string) {
      const temp: logItem = this.userIdList[userId]
      await ctx.localstorage.setItem(`${config.logsPath}/${userId}`, JSON.stringify(temp))
    }
  }

  /** 漂流瓶操作 */
  const driftbottle = {
    /** 基地址 */
    basePath: '',
    /** 历史记录存放基地址 */
    historyPath: '',
    /** id参考 用户递增 */
    nextId: 0,
    /** 用户数据 */
    userTempList: {},
    /** 用户获得瓶子历史记录 */
    historyTempList: {},
    /** 内容初始化 */
    async init() {
      this.basePath = path.join(ctx.localstorage.basePath, config.dataPath)
      this.historyPath = path.join(ctx.localstorage.basePath, config.historyPath)

      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
      if (!fs.existsSync(this.historyPath)) {
        fs.mkdirSync(this.historyPath, { recursive: true });
      }
      const dict = { data: { ok: 0, err: 0 }, history: { ok: 0, err: 0 }, path: { image: 0, audio: 0 } }
      const temp: { [key: string]: DiftInfo[] } = {}
      const historyTemp = {}
      const eventList = fs.readdirSync(this.basePath).map((item: string) => {
        return new Promise(async (reslove, rejects) => {
          try {
            const userTemp = (JSON.parse(await ctx.localstorage.getItem(`${config.dataPath}/${item}`)) as DiftInfo[])
              .map(withoutAdapterDisplayNames)

            if (config.autoCorrectionPath) {
              // 修复文件路径问题
              userTemp.forEach((item: DiftInfo) => {
                // 重置内容区域的图片地址
                if (item.content.image?.length) {
                  item.content.image = item.content.image.map((img: string) => {
                    dict.path.image++
                    return pathToFileURL(path.join(config.basePath, 'image', path.basename(img))).href
                  })
                }
                // 重置内容区域的音频地址
                if (item.content.audio?.length) {
                  item.content.audio = item.content.audio.map((url: string) => {
                    dict.path.audio++
                    return pathToFileURL(path.join(config.basePath, 'audio', path.basename(url))).href
                  })
                }
                // 重置评论区域的图片地址
                if (item.review?.length) {
                  item.review.forEach((review) => {
                    if (review.image) {
                      review.image = review.image.map((img) => {
                        dict.path.image++
                        return pathToFileURL(path.join(config.basePath, 'image', path.basename(img))).href
                      })
                    }
                  })
                }
              })
            }

            temp[item] = userTemp
            dict.data.ok++
            reslove(true)
          } catch (error) {
            dict.data.err++
            config.deBug && console.log(error);
            reslove(true)
          }
        })
      })
      const historyEventList = fs.readdirSync(this.historyPath).map((item: string) => {
        return new Promise(async (reslove, rejects) => {
          try {
            historyTemp[item] = JSON.parse(await ctx.localstorage.getItem(`${config.historyPath}/${item}`))
            dict.data.ok++
            reslove(true)
          } catch (error) {
            dict.data.err++
            config.deBug && console.log(error);
            reslove(true)
          }
        })
      })
      await Promise.all(eventList)
      config.deBug && console.log(`漂流瓶数据加载完成，一共加载成功${dict.data.ok}个用户数据，失败:${dict.data.err}个`);
      config.deBug && config.autoCorrectionPath && console.log(`*本地媒体文件路径自动矫正，一共有图片${dict.path.image}个,音频${dict.path.audio}个*`);
      await Promise.all(historyEventList)
      config.deBug && console.log(`历史数据加载完成，一共加载成功${dict.history.ok}个用户数据，失败:${dict.history.err}个`);
      // config.deBug && console.log(JSON.stringify(temp, null, ' '));

      // 找到最后一个 id
      this.nextId = [].concat(...Object.values(temp)).map((item) => item.id).sort((a, b) => b - a)[0] || 0
      this.userTempList = temp
      this.historyTempList = historyTemp
      // console.log(this.historyTempList);
    },
    /** 评论指定 id 的瓶子内容 */
    async setReviewForCententById(session: Session, id: number, msg: string) {

      if (!this.historyTempList[session.userId]) {
        this.historyTempList[session.userId] = []
      }

      if (!this.historyTempList[session.userId].includes(id) && !config.adminQQ.includes(session.userId)) {
        return `您并未捞到过 id 为：${id} 的瓶子，需要捞到过才可以指定选择读取瓶子内容`
      }

      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))
      const selectContent: DiftInfo = allContent.find((item) => item.id == id)
      if (!selectContent) {
        return `查找失败，没有找到对应id为 ${id} 的瓶子`
      }
      if (!selectContent.show) {
        return `id为 ${id} 的瓶子已被管理员清理...`
      }
      if (selectContent.content.audio !== null) {
        return "无法对语音瓶进行留言，留言操作失败！"
      }

      let text = h.select(msg, 'text').length ? h.select(msg, 'text')[0].attrs.content.trim() : null
      let imageUrl = h.select(msg, 'img').length ? h.select(msg, 'img').map((item) => item.attrs.src) : null

      // 不良内容安全验证
      if (imageUrl && imageUrl.length) {
        imageUrl = await delSetu.checkImg(session, imageUrl)
      }
      if (text) {
        text = await delSetu.checkText(text)
      }

      if (!text?.trim() && !imageUrl) {
        return `请填写内容，不能发送空内容作为留言发送！`
      }

      let storeImageUrl = []
      const dict = { img: { ok: 0, err: 0 } }

      // 存储图片到本地
      if (imageUrl) {
        const eventList = imageUrl.map((item: string) => {
          return new Promise(async (resolve, rejects) => {
            try {
              const upath = await downloadUilts.setStoreForImage(item)
              config.deBug && console.log(upath);
              storeImageUrl.push(upath)
              dict.img.ok++
              resolve(true)
            } catch (error) {
              console.log(error);
              dict.img.err++
              resolve(true)
            }
          })
        })
        await Promise.all(eventList)
        config.deBug && console.log(`图片数据保存本地完成，一共加载成功:${dict.img.ok}个，失败:${dict.img.err}个`);
      }
      const temp: DiftContent = {
        creatTime: +new Date(),
        text: tools.sanitizeText(text),
        userId: session.userId,
        image: storeImageUrl.length ? storeImageUrl : null
      }
      selectContent.review.push(temp)
      // 为自己添加留言日志
      logs.addLogForEvent(session.userId, {
        type: logType.LIUYAN,
        userId: session.userId,
        bottleId: selectContent.id,
        bottleType: this.driftbottleType(selectContent)
      })

      // 排除自己情况
      if (session.userId !== selectContent.userId) {
        // 为对方添加被留言日志
        logs.addLogForEvent(selectContent.userId, {
          type: logType.BEILIUYAN,
          userId: session.userId,
          bottleId: selectContent.id,
          bottleType: this.driftbottleType(selectContent)
        })
      }

      await session.send(`评论id:${id} 的` + this.driftbottleType(selectContent) + '成功！')
    },
    /** 封禁漂流瓶 */
    async closeCententById(session: Session, id: number) {
      if (!config.adminQQ.includes(session.userId)) {
        return `您并未管理员，无权操作...`
      }

      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))
      const selectContent: DiftInfo = allContent.find((item) => item.id == id)
      if (!selectContent) {
        return `查找失败，没有找到对应id为 ${id} 的瓶子`
      }
      // 举报已闭环（网页封禁或忽略过）时，QQ 端审核按钮提示已处理，两个处理入口不打架
      const reportRecord = reportRegistry.get('local', String(selectContent.id))
      if (reportRecord?.resolvedAt) {
        return `id为 ${id} 的漂流瓶举报已被处理，无需重复操作。`
      }
      if (!selectContent.show) {
        return `id为 ${id} 目前的状态已经是关闭显示的状态，无需再次关闭`
      }

      selectContent.show = false
      this.updateStoreUser(selectContent.userId)

      // 为目标添加封禁日志
      logs.addLogForEvent(selectContent.userId, {
        type: logType.SHANCHU,
        userId: session.userId,
        bottleId: selectContent.id,
        bottleType: this.driftbottleType(selectContent)
      })
      // 封禁即处理举报：闭环举报记录，不再重复通知
      await reportRegistry.resolve('local', String(selectContent.id))
      notifyPanelChange('ban')
      await session.send(`处理成功，已关闭显示 id:${id} 的` + this.driftbottleType(selectContent))
    },
    /** 管理员删除留言 */
    async delCommentByIdAndIndex(session: Session, id: number) {
      if (!config.allowDelOfAuthor) {
        if (!config.adminQQ.includes(session.userId)) {
          await session.send(`您并未管理员，无权操作...`)
          return
        }
      }

      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))
      const selectContent: DiftInfo = allContent.find((item) => item.id == id)
      if (!selectContent) {
        await session.send(`查找失败，没有找到对应id为 ${id} 的瓶子`)
        return
      }

      if (config.allowDelOfAuthor) {
        if (!(selectContent.userId == session.userId || config.adminQQ.includes(session.userId))) {
          await session.send(`您不是该瓶子的主人，无权在此瓶子中执行删除留言操作。`)
          return
        }
      }
      const visibleReviews = selectContent.review
        .map((item, index) => ({ item, index }))
        .filter(entry => !entry.item.isDel)
      if (!visibleReviews.length) {
        await session.send(`Id为 ${id} 的瓶子下并没有可删除的留言。无需操作。`)
        return
      }
      await session.send(
        buildAuxiliaryMessage(
          buildCommentSelectionText(selectContent, session.platform === 'qq'),
          session.platform,
        ),
      )
      const _delIndex = await session.prompt(20000)
      if (_delIndex == undefined) {
        await session.send('操作超时，结束处理')
        return
      }
      const delIndex = _delIndex.split(',').flatMap((item) => {
        if (isNaN(Number(item))) return []
        const displayIndex = Math.floor(Number(item)) - 1
        if (displayIndex < 0 || displayIndex >= visibleReviews.length) return []
        return [{
          displayIndex,
          reviewIndex: visibleReviews[displayIndex].index,
        }]
      })

      if (!delIndex.length) {
        await session.send(`未命中任意留言下标，主动操作结束。`)
        return
      }

      const dict = []

      delIndex.forEach(({ displayIndex, reviewIndex }) => {
        if (selectContent.review[reviewIndex].isDel) {
          dict.push(`[×] 下标 ${displayIndex + 1} 留言已经是删除状态，无需操作！`)
          return
        }
        // 为目标添加评论屏蔽日志
        logs.addLogForEvent(selectContent.review[reviewIndex].userId, {
          type: logType.PLFENGJIN,
          userId: session.userId,
          bottleId: selectContent.id,
          bottleType: this.driftbottleType(selectContent)
        })
        dict.push(`[√] 成功删除下标 ${displayIndex + 1} 留言！`)
        selectContent.review[reviewIndex].isDel = true
      })

      this.updateStoreUser(selectContent.userId)
      notifyPanelChange('delete-review')
      await session.send(`操作结果：\n\n${dict.join('\n')}`)
    },
    /** 解封漂流瓶 */
    async openCententById(session: Session, id: number) {
      if (!config.adminQQ.includes(session.userId)) {
        return `您并未管理员，无权操作...`
      }

      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))
      const selectContent: DiftInfo = allContent.find((item) => item.id == id)
      if (!selectContent) {
        return `查找失败，没有找到对应id为 ${id} 的瓶子`
      }
      if (selectContent.show) {
        return `id为 ${id} 目前的状态已经是开放显示的状态，无需再次开放`
      }

      selectContent.show = true
      this.updateStoreUser(selectContent.userId)

      // 为目标添加解封日志
      logs.addLogForEvent(selectContent.userId, {
        type: logType.JIEFENG,
        userId: session.userId,
        bottleId: selectContent.id,
        bottleType: this.driftbottleType(selectContent)
      })
      notifyPanelChange('unban')
      await session.send(`处理成功，已开放显示 id:${id} 的` + this.driftbottleType(selectContent))
    },
    /** 收集瓶子内容：内容检查 + 媒体下载，不执行入海动作（入海或预审由调用方决定） */
    async collectBottleContent(session: Session, content: string, title: string | null): Promise<{ ok: true, content: PendingSubmissionRecord['content'] } | { ok: false, msg: string }> {
      const userId = session.userId
      // 收集
      const audioList = h.select(content, 'audio')
      const imageList = h.select(content, 'img')
      // 过滤
      let audioUrl = audioList.length ? audioList.map((item) => item.attrs.src) : null
      let imageUrl = imageList.length ? imageList.map((item) => item.attrs.src) : null
      let text = h.select(content, 'text')[0]?.attrs.content.trim() || null

      if (![audioUrl, imageUrl, text].some(item => item !== null)) {
        return { ok: false, msg: `瓶子没有内容是不允许丢出的噢~ 请为瓶子填写内容。\n可以为 文本+图片 或者 音频` }
      }

      // 不良内容安全验证
      if (imageUrl && imageUrl.length) {
        imageUrl = await delSetu.checkImg(session, imageUrl)
      }
      if (text) {
        text = await delSetu.checkText(text)
      }

      let storeAudioUrl = []
      let storeImageUrl = []
      const dict = { img: { ok: 0, err: 0 }, audio: { ok: 0, err: 0 } }
      // 存储音频到本地
      if (audioUrl) {
        const eventList = audioUrl.map((item: string) => {
          return new Promise(async (resolve, rejects) => {
            try {
              const upath = await downloadUilts.setStoreForAudio(item)
              config.deBug && console.log(upath);
              storeAudioUrl.push(upath)
              dict.audio.ok++
              resolve(true)
            } catch (error) {
              console.log(error);
              dict.audio.err++
              resolve(true)
            }
          })
        })
        await Promise.all(eventList)
        config.deBug && console.log(`音频数据保存本地完成，一共加载成功:${dict.audio.ok}个，失败:${dict.audio.err}个`);
      }
      // 存储图片到本地
      if (imageUrl) {
        const eventList = imageUrl.map((item: string) => {
          return new Promise(async (resolve, rejects) => {
            try {
              const upath = await downloadUilts.setStoreForImage(item)
              config.deBug && console.log(upath);
              storeImageUrl.push(upath)
              dict.img.ok++
              resolve(true)
            } catch (error) {
              console.log(error);
              dict.img.err++
              resolve(true)
            }
          })
        })
        await Promise.all(eventList)
        config.deBug && console.log(`图片数据保存本地完成，一共加载成功:${dict.img.ok}个，失败:${dict.img.err}个`);
      }

      return {
        ok: true,
        content: {
          creatTime: +new Date(),
          text: tools.sanitizeText(text),
          title: tools.sanitizeText(title),
          image: storeImageUrl.length ? storeImageUrl : null,
          audio: storeAudioUrl.length ? storeAudioUrl : null,
        },
      }
    },
    /** 把收集好的内容转正为瓶子：分配 ID、入海、写发布日志 */
    async finalizeBottle(userId: string, collected: PendingSubmissionRecord['content']): Promise<DiftInfo> {
      // 为瓶子赋予 id
      const id = ++this.nextId
      // 撰写信息对象
      const temp: DiftInfo = {
        id,
        getCount: 0,
        content: { ...collected, userId },
        show: true,
        userId,
        style: 0,
        review: []
      }

      if (!this.userTempList[userId]) {
        this.userTempList[userId] = []
      }
      this.userTempList[userId].push(temp)
      this.updateStoreUser(userId)
      this.historyGetContentId(userId, id)
      config.deBug && console.log(JSON.stringify(temp, null, ' '));

      // 为自己添加发布日志
      logs.addLogForEvent(userId, {
        type: logType.FABU,
        userId,
        bottleId: temp.id,
        bottleType: this.driftbottleType(temp)
      })
      return temp
    },
    /** 预审通过：待审投稿转正为瓶子入海（媒体文件复用投稿时已下载的副本） */
    async publishApprovedSubmission(record: PendingSubmissionRecord): Promise<DiftInfo> {
      return await this.finalizeBottle(record.userId, record.content)
    },
    /** 获得随机瓶子 */
    async randomGetDriftContent(session) {
      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList)).filter((item: DiftInfo) => item.show)
      const id = Math.round(Math.random() * (allContent.length - 1))
      console.log(allContent.length, id);

      const randomContent: DiftInfo = allContent[id]
      console.log(randomContent);
      await session.send(`你捞到一个` + this.driftbottleType(randomContent) + '\n稍等，正在为你展开内容...')
      randomContent.getCount++

      // 为自己记录获得日志
      logs.addLogForEvent(session.userId, {
        type: logType.HUOQU,
        userId: session.userId,
        bottleId: randomContent.id,
        bottleType: this.driftbottleType(randomContent)
      })

      // 排除自己情况
      if (session.userId !== randomContent.userId) {
        if (!this.historyTempList[session.userId]) {
          this.historyTempList[session.userId] = []
        }
        // 为对方记录被首次获得的日志
        if (!this.historyTempList[session.userId].includes(id)) {
          logs.addLogForEvent(randomContent.userId, {
            type: logType.BEIHUOQU,
            userId: session.userId,
            bottleId: randomContent.id,
            bottleType: this.driftbottleType(randomContent)
          })
        }
      }

      // 记录获得的瓶子
      this.historyGetContentId(session.userId, randomContent.id)
      this.updateStoreUser(randomContent.userId)
      await this.formatDriftContent(session, randomContent)
      return
    },
    /** 存储得到的瓶子记录 */
    async historyGetContentId(userId: string, id: number) {
      if (!this.historyTempList[userId]) {
        this.historyTempList[userId] = []
      }
      this.historyTempList[userId] = this.historyTempList[userId].filter((item: number) => item != id)
      this.historyTempList[userId].push(id)
      await this.updateStoreHistory(userId)
    },
    // 获取所有可用瓶子
    GetAllBottle(): DiftInfo[] {
      return [].concat(...Object.values(this.userTempList))
    },
    /** 获得指定瓶子 */
    async GetDriftContentById(session: Session, id: number) {

      if (!this.historyTempList[session.userId]) {
        this.historyTempList[session.userId] = []
        this.updateStoreHistory(session.userId)
      }
      if (!this.historyTempList[session.userId].includes(id) && !config.adminQQ.includes(session.userId)) {
        return `您并未捞到过 id 为：${id} 的瓶子，需要捞到过才可以指定选择读取瓶子内容`
      }

      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))
      const selectContent: DiftInfo = allContent.find((item) => item.id == id)
      if (!selectContent) {
        return `查找失败，没有找到对应id为 ${id} 的瓶子`
      }
      if (!selectContent.show) {
        return `id为 ${id} 的瓶子已被管理员清理...`
      }

      config.deBug && console.log(selectContent);
      await session.send(`指定获取id为${id}的` + this.driftbottleType(selectContent) + '\n稍等，正在为你展开内容...')
      selectContent.getCount++
      this.updateStoreUser(selectContent.userId)
      await this.formatDriftContent(session, selectContent)
      return
    },
    /** 格式化瓶子内容 */
    async formatDriftContent(session: Session, bottle: DiftInfo): Promise<void> {
      const displayBottle = await withAdapterDisplayNames(
        session,
        bottle,
        config.uapisApiKey,
        ctx.http,
        Math.max(0, config.uapisCacheMinutes ?? 60) * 60_000,
        (ctx as unknown as { database?: KoishiUserDatabase }).database,
      )
      await sendBottleBundle(
        session,
        await buildLocalBottleMessages(
          displayBottle,
          session.platform,
          (ctx as Context & { assets?: AssetTransformer }).assets,
          {
            canBan: Boolean(config.adminQQ?.includes(session.userId)),
            canDeleteComments: Boolean(
              config.adminQQ?.includes(session.userId)
              || (config.allowDelOfAuthor && bottle.userId === session.userId),
            ),
          },
          ctx.http as ImageDataLoader,
        ),
      )
    },
    /** 获取漂流瓶统计数据 */
    getDriftbottleStatistics(session: Session): BottleStatistics {
      const allContent: DiftInfo[] = [].concat(...Object.values(this.userTempList))

      const hiddenContent: DiftInfo[] = [] // 封禁的瓶子
      const lostContent: DiftInfo[] = [] // 没捞过的瓶子
      const myContent: DiftInfo[] = [] // 我发布的瓶子
      const reviewContent: DiftInfo[] = [] // 我评论过的瓶子
      const typeList: string[] = []

      // 统计队列
      const reviewTotal = allContent.map((item) => {
        if (!item.show) {
          hiddenContent.push(item)
        }
        if (item.getCount === 0) {
          lostContent.push(item)
        }
        if (item.userId === session.userId) {
          myContent.push(item)
        }
        if (item.review.some((i) => i.userId === session.userId)) {
          reviewContent.push(item)
        }
        typeList.push(driftbottle.driftbottleType(item))
        return item.review.length
      }).reduce((a, b) => a + b, 0)

      const typeKey: Record<string, number> = {}
      typeList.forEach((item) => {
        if (!typeKey[item]) {
          typeKey[item] = 0
        }
        typeKey[item]++
      })

      return {
        total: allContent.length,
        hidden: hiddenContent.length,
        neverScooped: lostContent.length,
        reviewTotal,
        own: myContent.length,
        reviewed: reviewContent.length,
        typeCounts: typeKey,
      }
    },
    /** 漂流瓶统计 */
    driftbottleTatistics(session: Session) {
      return buildStatisticsBundle(this.getDriftbottleStatistics(session), session.platform)
    },
    /** 获取用户历史获取瓶子记录 */
    async getHistoryFormatData(session: Session) {
      const userId = session.userId
      const historyData = this.historyTempList[userId]
      if (!historyData?.length) {
        await sendBottleBundle(session, buildHistoryBundle([], 0, session.platform))
        return
      }
      // 获取所有数据
      const allDriftbottleList = [].concat(...Object.values(this.userTempList)) as DiftInfo[]
      // 装载瓶子信息
      const historyDetailList: HistoryInfoList[] = historyData.map((id: number) => {
        const d_item = allDriftbottleList.find((i) => i.id == id)
        if (d_item) {
          return {
            userId: d_item.userId,
            id,
            type: driftbottle.driftbottleType(d_item)
          }
        } else {
          return null
        }
      }).filter((item: any) => item).reverse();
      const visibleHistory = historyDetailList.slice(0, 49).filter(Boolean)
      const resolveName = createAdapterDisplayNameResolver(
        session,
        config.uapisApiKey,
        ctx.http,
        Math.max(0, config.uapisCacheMinutes ?? 60) * 60_000,
        (ctx as unknown as { database?: KoishiUserDatabase }).database,
      )
      const displayHistory = await Promise.all(visibleHistory.map(async item => ({
        ...item,
        username: await resolveName(item.userId) || undefined,
      })))
      await sendBottleBundle(
        session,
        buildHistoryBundle(displayHistory, historyDetailList.length, session.platform),
      )
    },
    /** 瓶子类型判断（也适用于待审投稿的内容） */
    driftbottleType(temp: Pick<DiftInfo, 'content'>) {
      const audioUrl = temp.content.audio
      const imageUrl = temp.content.image
      const text = temp.content.text
      return audioUrl ? "语音瓶" : imageUrl && text ? "图文瓶" : imageUrl ? "图片瓶" : "文本瓶"
    },
    /** 持久化单用户数据 */
    async updateStoreUser(userId: string) {
      const temp = (this.userTempList[userId] || []).map(withoutAdapterDisplayNames)
      this.userTempList[userId] = temp
      await ctx.localstorage.setItem(`${config.dataPath}/${userId}`, JSON.stringify(temp))
    },
    /** 持久化单用户数据 */
    async updateStoreHistory(userId: string) {
      const temp = this.historyTempList[userId]
      await ctx.localstorage.setItem(`${config.historyPath}/${userId}`, JSON.stringify(temp))
    }
  }

  // 不良内容识别
  const delSetu = {
    // 生成签名
    getSignature() {
      function generateHmacSha256(key2, data) {
        const hmac = crypto.createHmac("sha256", key2);
        hmac.update(data);
        const hash = hmac.digest("hex");
        return hash;
      }
      const apiId = config.Appid;
      const key = config.key;
      const time = Math.floor(+new Date() / 1e3);
      const queryKey = {
        "Api-Appid": apiId,
        "Api-Nonce-Str": "123456",
        "Api-Timestamp": time,
        "key": key
      };
      const ascllSortMap = Object.keys(queryKey).sort();
      const strKey = ascllSortMap.map((item) => {
        return `${item}=${queryKey[item]}`;
      }).join("&");
      console.log(strKey);
      const keyData = generateHmacSha256(key, strKey).toUpperCase();
      return {
        "Api-Appid": apiId,
        "Api-Nonce-Str": "123456",
        "Api-Timestamp": time,
        "Api-Sign": keyData
      };
    },
    async checkImg(session: Session, imgList: string[]) {
      if (config.isExamine && config.Appid && config.key) {
        const dict = { err: 0 };
        const eventList = imgList.map((item, index) => {
          return new Promise(async (resolve, reject) => {
            try {
              const md5 = await tool.getPicMd5(item)
              let result2 = null
              if (!tool.checkPicRepeatDyMD5(md5)) {
                result2 = await ctx.http.post(`https://tools.mgtv100.com/external/v1/qcloud_content_audit`, {
                  audit_type: "image",
                  audit_content: item
                }, {
                  headers: delSetu.getSignature()
                });
                tool.putPicMd5TempData(md5, result2)
              } else {
                result2 = tool.md5temp[md5]
              }
              if (result2.code == 200 && result2.data?.LabelResults) {
                const flag = result2.data.LabelResults.every((item2) => {
                  if (config.filter.includes(item2.Scene) && item2.Suggestion !== "Pass") {
                    return false;
                  } else {
                    return true;
                  }
                });
                if (!flag) {
                  dict.err++;
                  // 处理不良策略 拒收
                  if (config.delOrBlur == 0) {
                    imgList[index] = null;
                  }
                  // 处理不良策略 高斯模糊
                  else if (config.delOrBlur == 1) {
                    try {
                      const blurResult = await ctx.http.get(`https://api.52vmy.cn/api/img/gaussian?url=${imgList[index]}`)
                      imgList[index] = blurResult.url
                    } catch (error) {
                      console.log("高斯模糊接口可能失效。转为拒收逻辑");
                      imgList[index] = null;
                    }
                  }

                }
              } else {
                console.log("不良图像审核处理失败，检测 key 是否失效或者有效。或 key 的次数用完");
              }
              resolve(true);

            } catch (error) {
              console.log(error);
              resolve(true);
            }
          });
        });
        await Promise.all(eventList);
        if (dict.err) {
          await session.send(`存在${dict.err}张不良图片，提交前已${config.delOrBlur ? "模糊" : "过滤"}`);
        }
        return imgList.filter((item) => item !== null);
      } else {
        return imgList
      }
    },
    async checkText(msg: String) {
      if (config.isExamine && config.Appid && config.key) {
        try {
          const result2 = await ctx.http.post(`https://tools.mgtv100.com/external/v1/qcloud_content_audit`, {
            audit_type: "text",
            audit_content: msg
          }, {
            headers: delSetu.getSignature()
          });
          if (result2.code == 200 && result2.data?.DetailResults) {
            result2.data.DetailResults.forEach((item) => {
              if (config.textfilter.includes(item.Label) && item.Suggestion !== "Pass") {
                item.Keywords.forEach((text) => {
                  msg = msg.replace(new RegExp(text, "g"), "***");
                });
              }
            });
          } else {
            console.log("不良文本审核处理失败，检测 key 是否失效或者有效。或 key 的次数用完");
          }
          return msg
        } catch (error) {
          console.log(error);
          return msg
        }
      } else {
        return msg
      }
    }
  }

  // md5 优化
  const tool = {
    md5temp: {},
    md5Len: [],
    async getPicMd5(imageUrl) {
      const response = await ctx.http.get(imageUrl, { responseType: "arraybuffer" });
      const hash = crypto.createHash("md5");
      const buffer = hash.update(Buffer.from(response));
      return buffer.digest("hex");
    },
    // 校验图片是否存在MD5缓存
    checkPicRepeatDyMD5(md5Data) {
      if (this.md5temp[md5Data]) {
        config.deBug && console.log("存在重复图片 返回缓存");
        return this.md5temp[md5Data];
      }
      return null;
    },
    // 将返回的结果存进MD5缓存
    putPicMd5TempData(md5Data, result) {
      if (!this.md5temp[md5Data]) {
        config.deBug && console.log("新图 开始存入缓存");
        this.md5temp[md5Data] = result;
        this.md5Len.push(md5Data)
        this.tempFullToDelect();
        config.deBug && console.log("新图 完成存入缓存");
      }
    },
    // 超过约束的数量自动清理
    tempFullToDelect() {
      if (this.md5Len.length > 300) {
        config.deBug && console.log("缓存超过约束长度，执行清理");
        const delMd5 = this.md5Len.shift();
        delete this.md5temp[delMd5];
      }
    }
  };


  const reportRegistry = new BottleReportRegistry(
    ctx.localstorage,
    config.dataPath + '-reports/reports.json',
    config.reportThreshold,
  )
  const cloudBottleCache = new Map<string, WebBottleData>()

  /** 删除待审投稿已下载到本地媒体目录的文件（驳回/撤回时调用，失败只记日志） */
  const removePendingMedia = async (record: PendingSubmissionRecord) => {
    const sources = [...(record.content.image || []), ...(record.content.audio || [])]
    for (const source of sources) {
      try {
        const url = new URL(source)
        if (url.protocol !== 'file:') continue
        const name = path.basename(decodeURIComponent(url.pathname))
        if (!name) continue
        for (const kind of ['image', 'audio'] as const) {
          const target = path.join(downloadUilts.basePath, kind, name)
          if (fs.existsSync(target)) fs.unlinkSync(target)
        }
        config.deBug && console.log(`已清理待审投稿媒体文件 ${name}`)
      } catch (error) {
        config.deBug && console.log(error)
      }
    }
  }

  /** 待审区：与瓶子数据、历史记录平级的独立命名空间，批量上传云瓶不会读取 */
  const pendingRegistry = new PendingSubmissionRegistry(
    ctx.localstorage,
    config.dataPath + '-pre-review/submissions.json',
    removePendingMedia,
  )

  // 控制台管理面板：仅管理本地瓶，权限只依赖控制台登录
  ctx.plugin(setupConsole, {
    config,
    glue: {
      driftbottle: {
        GetAllBottle: () => driftbottle.GetAllBottle(),
        updateStoreUser: (userId) => driftbottle.updateStoreUser(userId),
        driftbottleType: (bottle) => driftbottle.driftbottleType(bottle),
      },
      logs: {
        addLogForEvent: (userId, info) => logs.addLogForEvent(userId, info),
      },
      logTypes: { ban: logType.SHANCHU, unban: logType.JIEFENG, reviewDeleted: logType.PLFENGJIN },
      reportRegistry,
      pendingRegistry,
      approvePending: (pendingId, operator) =>
        approvePendingSubmission(null, pendingId).then(result =>
          result.ok ? { ok: true } : { ok: false, reason: 'pending_not_found' },
        ),
      rejectPending: (pendingId, operator, reason) =>
        rejectPendingSubmission(null, operator, pendingId, reason).then(result =>
          result.ok ? { ok: true } : { ok: false, reason: 'pending_not_found' },
        ),
      mediaBasePath: downloadUilts.basePath,
      notifyChange: (action) => notifyPanelChange(action),
    } satisfies ConsoleGlue,
  })
  const broadcastChange = (action: string) => {
    ctx.get('console')?.broadcast('driftbottle-console/changed', { action, at: +new Date() })
  }
  changeListeners.add(broadcastChange)
  ctx.on('dispose', () => {
    changeListeners.delete(broadcastChange)
  })

  const reports = {
    rememberCloudBottle(bottle: WebBottleData) {
      cloudBottleCache.set(String(bottle.id), bottle)
    },
    async notifyAdmins(session: Session, notice: Parameters<typeof buildReportAdminBundle>[0]) {
      const admins = [...new Set((config.adminQQ || []).filter(Boolean))]
      if (!admins.length) {
        ctx.logger(name).warn('举报数量已达到阈值，但 adminQQ 未配置，无法发送审核通知。')
        return false
      }

      const bundle = buildReportAdminBundle(notice, session.platform)
      let delivered = 0
      for (const adminId of admins) {
        try {
          await sendProactivePrivateMessage(session.bot, adminId, bundle.primary)
          delivered++
        } catch (primaryError) {
          try {
            await sendProactivePrivateMessage(session.bot, adminId, bundle.fallback)
            delivered++
          } catch (fallbackError) {
            ctx.logger(name).warn(
              fallbackError,
              '向管理员 %s 推送漂流瓶举报审核消息失败，原始错误：%o',
              adminId,
              primaryError,
            )
          }
        }
      }
      return delivered > 0
    },
    async submit(session: Session, rawBottleId: string, rawScope?: string) {
      const bottleId = String(rawBottleId || '').trim()
      if (!bottleId) return '请提供需要举报的漂流瓶 ID。'

      let scope: ReportScope
      if (!rawScope || rawScope === 'local' || rawScope === '本地') {
        scope = 'local'
      } else if (rawScope === 'cloud' || rawScope === '云') {
        scope = 'cloud'
      } else {
        return '举报范围只能是 local（本地瓶）或 cloud（云瓶）。'
      }

      let title = ''
      let authorId = ''
      if (scope === 'local') {
        const bottle = driftbottle.GetAllBottle().find(item => String(item.id) === bottleId)
        if (!bottle) return '没有找到 ID 为 ' + bottleId + ' 的本地漂流瓶。'
        if (!bottle.show) return '该漂流瓶已经被管理员封禁，无需重复举报。'
        title = bottle.content.title || ''
        authorId = bottle.userId
      } else {
        let bottle = cloudBottleCache.get(bottleId)
        if (!bottle) {
          const numericId = Number(bottleId)
          if (!Number.isInteger(numericId) || numericId < 0) return '云漂流瓶 ID 必须是有效数字。'
          const result = await webBottle.getWebBottleData(session, numericId)
          if (!result.code) return '没有找到 ID 为 ' + bottleId + ' 的云漂流瓶。'
          bottle = result.data as WebBottleData
          reports.rememberCloudBottle(bottle)
        }
        title = bottle.content.title || ''
        authorId = bottle.content.userId || bottle.userId
      }

      if (authorId && authorId === session.userId) return '不能举报自己发布的漂流瓶。'
      const result = await reportRegistry.submit(scope, bottleId, session.userId)
      if (result.duplicate) {
        return '你已经举报过这个漂流瓶，请等待管理员处理。'
      }
      // 新举报到达时通知控制台面板刷新（本地瓶才在面板范围内）
      if (scope === 'local') notifyPanelChange('report')

      let notificationText = ''
      if (result.shouldNotify) {
        const success = await reports.notifyAdmins(session, {
          scope,
          bottleId,
          reportCount: result.record.reporterIds.length,
          threshold: config.reportThreshold,
          reporterId: session.userId,
          title,
          authorId,
        })
        await reportRegistry.completeNotification(scope, bottleId, success)
        notificationText = success
          ? '\n举报数量已达到阈值，已向管理员 QQ 推送审核通知。'
          : '\n举报数量已达到阈值，但管理员主动消息发送失败；记录已保留，后续举报会再次尝试通知。'
      } else if (result.record.notifiedAt) {
        notificationText = '\n该漂流瓶此前已进入管理员审核流程。'
      } else {
        notificationText = '\n当前举报数量：' + result.record.reporterIds.length + ' / ' + config.reportThreshold + '。'
      }
      return '举报成功，感谢你的反馈。' + notificationText
    },
  }

  /** 作者私信推送：QQ 指令与控制台面板共用，失败仅记日志不阻断流程 */
  function pushAuthorNotice(session: Session | null, userId: string, content: h.Fragment): Promise<boolean> {
    const bot = session?.bot ?? ctx.bots.find(item => item.platform === 'qq') ?? ctx.bots[0]
    if (!bot) {
      ctx.logger(name).warn('当前没有可用机器人，无法向用户 %s 推送预审结果。', userId)
      return Promise.resolve(false)
    }
    return sendProactivePrivateMessage(bot, userId, content)
      .then(() => true)
      .catch((error) => {
        ctx.logger(name).warn(error, '向用户 %s 推送预审结果失败。', userId)
        return false
      })
  }

  /** 新待审投稿产生时主动私信 adminQQ（primary 失败发 fallback） */
  async function notifyAdminsOfPendingSubmission(session: Session, record: PendingSubmissionRecord): Promise<boolean> {
    const admins = [...new Set((config.adminQQ || []).filter(Boolean))]
    if (!admins.length) {
      ctx.logger(name).warn('有新的待审投稿，但 adminQQ 未配置，无法发送预审通知。')
      return false
    }
    const bundle = buildPreReviewAdminBundle(
      {
        pendingId: record.pendingId,
        authorId: record.userId,
        summary: buildSubmissionSummary(record.content),
      },
      session.platform,
    )
    let delivered = 0
    for (const adminId of admins) {
      try {
        await sendProactivePrivateMessage(session.bot, adminId, bundle.primary)
        delivered++
      } catch (primaryError) {
        try {
          await sendProactivePrivateMessage(session.bot, adminId, bundle.fallback)
          delivered++
        } catch (fallbackError) {
          ctx.logger(name).warn(
            fallbackError,
            '向管理员 %s 推送待审投稿通知失败，原始错误：%o',
            adminId,
            primaryError,
          )
        }
      }
    }
    return delivered > 0
  }

  /** 通过预审：待审投稿转正为瓶子入海；返回结构化结果供 QQ 指令与控制台共用 */
  async function approvePendingSubmission(session: Session | null, pendingId: number): Promise<{ ok: boolean, message: string }> {
    const record = await pendingRegistry.approve(pendingId)
    if (!record) {
      return { ok: false, message: '没有找到编号 ' + pendingId + ' 的待审投稿，或它已被处理。' }
    }
    const bottle = await driftbottle.publishApprovedSubmission(record)
    notifyPanelChange('approve-submission')
    if (record.notifyAuthor) {
      await pushAuthorNotice(session, record.userId, buildPreReviewResultPush(
        { pendingId, approved: true, bottleId: bottle.id },
        session?.platform ?? 'qq',
      ))
    }
    return { ok: true, message: '已通过编号 ' + pendingId + ' 的待审投稿，瓶子已入海，ID 为：' + bottle.id + '。' }
  }

  /** 驳回预审：丢弃投稿与媒体文件；理由仅进作者日志与订阅推送 */
  async function rejectPendingSubmission(session: Session | null, operatorId: string, pendingId: number, reason: string): Promise<{ ok: boolean, message: string }> {
    const record = await pendingRegistry.reject(pendingId)
    if (!record) {
      return { ok: false, message: '没有找到编号 ' + pendingId + ' 的待审投稿，或它已被处理。' }
    }
    logs.addLogForEvent(record.userId, {
      type: logType.BOHUI,
      userId: operatorId,
      bottleId: pendingId,
      bottleType: '待审投稿',
      reason: reason || undefined,
    })
    notifyPanelChange('reject-submission')
    if (record.notifyAuthor) {
      await pushAuthorNotice(session, record.userId, buildPreReviewResultPush(
        { pendingId, approved: false, reason: reason || undefined },
        session?.platform ?? 'qq',
      ))
    }
    return { ok: true, message: '已驳回编号 ' + pendingId + ' 的待审投稿，相关内容已被丢弃。' }
  }

  /** 作者撤回自己的待审投稿，效果与驳回一致 */
  async function withdrawPendingSubmission(session: Session, pendingId: number): Promise<string> {
    const record = await pendingRegistry.withdraw(pendingId, session.userId)
    if (!record) {
      return '没有找到编号 ' + pendingId + ' 的待审投稿，或它已被管理员处理，无法撤回。'
    }
    notifyPanelChange('withdraw-submission')
    return '已撤回编号 ' + pendingId + ' 的待审投稿，相关内容已被丢弃。'
  }

  ctx.on('ready', async () => {
    await driftbottle.init()
    await logs.init()
    await reportRegistry.init()
    await pendingRegistry.init()
    await webBottle.init(ctx, config)
  })

  ctx
    .command('漂流瓶', '查看漂流瓶功能菜单')
    .action(async ({ session }) => {
      await sendBottleBundle(
        session,
        buildMainMenuBundle(session.platform, driftbottle.getDriftbottleStatistics(session)),
      )
    })

  ctx
    .command('漂流瓶/捞漂流瓶 <num:number>', '从大海中随机获得一个瓶子')
    .action(async ({ session }, num) => {
      const type = cooling.check(session.userId, UseType.LaoPingZi)
      if (!type[0]) {
        return `你捞瓶子的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      num = num && Math.abs(Math.floor(num))

      if (num) {
        return await driftbottle.GetDriftContentById(session, num)
      } else {
        return await driftbottle.randomGetDriftContent(session)
      }
    })

  ctx
    .command('漂流瓶/留言 <pid:number> <msg:text>', '对指定id的瓶子进行留言')
    .action(async ({ session }, pid, msg) => {
      const type = cooling.check(session.userId, UseType.LiuYan)
      if (!type[0]) {
        return `你留言的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      if (pid == undefined) {
        return `发送失败，请先填写需要留言的漂流瓶的对应 id\n例如：留言 1 这是内容`
      }
      pid = Math.abs(Math.floor(pid))
      return await driftbottle.setReviewForCententById(session, pid, msg)
    })

  ctx
    .command('漂流瓶/举报漂流瓶 <pid:string> [scope:string]', '举报指定漂流瓶')
    .action(async ({ session }, pid, scope) => {
      return await reports.submit(session, pid, scope)
    })

  ctx
    .command('漂流瓶/扔漂流瓶 <msgContent:text>', '将内容存瓶子丢向大海')
    .action(async ({ session }, msgContent) => {
      const type = cooling.check(session.userId, UseType.RenPingZi)
      if (!type[0]) {
        return `你扔瓶子的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      let res = msgContent || ''

      if (!res.trim()) {
        await session.send(buildThrowBottlePrompt('content', session.platform))
        const contentInput = await session.prompt(60000)
        if (contentInput === undefined) {
          await session.send(buildThrowBottleResultMessage(
            '等待瓶子内容超时，本次操作已取消。',
            session.platform,
            false,
          ))
          return
        }
        if (contentInput.trim() === THROW_BOTTLE_CANCEL_VALUE) {
          await session.send(buildThrowBottleResultMessage('已取消本次扔漂流瓶操作。', session.platform, false))
          return
        }
        res = contentInput
      }
      if (!res?.trim()) {
        await session.send(buildThrowBottleResultMessage('未收到有效的瓶子内容，本次操作已取消。', session.platform, false))
        return
      }

      // 判断是否需要添加图片内容
      if (h.select(res, 'aduio').length == 0 && h.select(res, 'img').length == 0) {
        await session.send(buildThrowBottlePrompt('image', session.platform))
        const imgTemp = await session.prompt(20000)
        const imageInput = imgTemp?.trim()
        if (imageInput === THROW_BOTTLE_CANCEL_VALUE) {
          await session.send(buildThrowBottleResultMessage('已取消本次扔漂流瓶操作。', session.platform, false))
          return
        }
        const skipImage = imageInput === THROW_BOTTLE_SKIP_IMAGE_VALUE || imageInput === '否'
        const imgList = !skipImage && imgTemp
          ? h.select(imgTemp, 'img').map((item) => h.image(item.attrs.src))
          : null
        if (imgList?.length) {
          res += imgList
        } else if (imgTemp !== undefined && !skipImage) {
          await session.send(buildAuxiliaryMessage(
            '## 配图未添加\n> 没有检测到有效图片，将继续创建无配图漂流瓶。',
            session.platform,
          ))
        }
      }

      await session.send(buildThrowBottlePrompt('title', session.platform))
      let title = await session.prompt(20000)
      const titleInput = title?.trim()
      if (titleInput === THROW_BOTTLE_CANCEL_VALUE) {
        await session.send(buildThrowBottleResultMessage('已取消本次扔漂流瓶操作。', session.platform, false))
        return
      }
      const skipTitle = titleInput === THROW_BOTTLE_SKIP_TITLE_VALUE || titleInput === '否'
      const finalTitle = title && !skipTitle
        ? (h.select(title, 'text')[0]?.attrs.content ?? null)
        : null
      const collected = await driftbottle.collectBottleContent(session, res, finalTitle)
      if (collected.ok === false) {
        await session.send(buildThrowBottleResultMessage(collected.msg, session.platform, false))
        return
      }

      // 自动内容安全审核实际不可用时，非管理员扔瓶进入人工预审（见 docs/adr/0001）
      if (isPreReviewRequired(config) && !config.adminQQ.includes(session.userId)) {
        await session.send(buildPreReviewNotifyPrompt(session.platform))
        const notifyInput = await session.prompt(20000)
        const notifyAuthor = notifyInput?.trim() === PRE_REVIEW_NOTIFY_VALUE
        const record = await pendingRegistry.submit({
          userId: session.userId,
          content: collected.content,
          notifyAuthor,
        })
        await sendBottleBundle(
          session,
          buildPendingSubmissionReceipt(
            record.pendingId,
            driftbottle.driftbottleType({ content: record.content }),
            session.platform,
          ),
        )
        await notifyAdminsOfPendingSubmission(session, record)
        notifyPanelChange('submit-submission')
        return
      }

      const bottle = await driftbottle.finalizeBottle(session.userId, collected.content)
      await session.send(buildThrowBottleResultMessage(
        '你成功扔出了一个' + driftbottle.driftbottleType(bottle) + '\n瓶子ID为：' + bottle.id,
        session.platform,
        true,
      ))
    })

  ctx
    .command('漂流瓶/封漂流瓶 <pid:number>', '封禁指定id漂流瓶')
    .action(async ({ session }, pid) => {
      if (pid == undefined) {
        return `确认你是否携带id参数`
      }
      pid = Math.abs(Math.floor(pid))
      return await driftbottle.closeCententById(session, pid)
    })

  ctx
    .command('漂流瓶/解漂流瓶 <pid:number>', '为目标id漂流瓶解封')
    .action(async ({ session }, pid) => {
      if (pid == undefined) {
        return `确认你是否携带id参数`
      }
      pid = Math.abs(Math.floor(pid))
      return await driftbottle.openCententById(session, pid)
    })

  ctx
    .command('漂流瓶/通过投稿 <pendingId:number>', '通过指定待审编号的投稿，使其入海')
    .action(async ({ session }, pendingId) => {
      if (!config.adminQQ.includes(session.userId)) {
        return '您并未管理员，无权操作...'
      }
      if (pendingId == undefined) {
        return '请携带待审编号，例如：通过投稿 1'
      }
      pendingId = Math.abs(Math.floor(pendingId))
      const result = await approvePendingSubmission(session, pendingId)
      await session.send(buildAuxiliaryMessage(result.message, session.platform))
    })

  ctx
    .command('漂流瓶/驳回投稿 <pendingId:number>', '驳回指定待审编号的投稿，可附带理由')
    .action(async ({ session }, pendingId) => {
      if (!config.adminQQ.includes(session.userId)) {
        return '您并未管理员，无权操作...'
      }
      if (pendingId == undefined) {
        return '请携带待审编号，例如：驳回投稿 1'
      }
      pendingId = Math.abs(Math.floor(pendingId))
      await session.send(buildRejectReasonPrompt(pendingId, session.platform))
      const reasonInput = await session.prompt(20000)
      if (reasonInput === undefined) {
        await session.send('操作超时，结束处理')
        return
      }
      const rawReason = (h.select(reasonInput, 'text')[0]?.attrs.content ?? reasonInput).trim()
      const reason = !rawReason || rawReason === REJECT_REASON_SKIP_VALUE || rawReason === '否' ? '' : rawReason
      const result = await rejectPendingSubmission(session, session.userId, pendingId, reason)
      await session.send(buildAuxiliaryMessage(result.message, session.platform))
    })

  ctx
    .command('漂流瓶/撤回投稿 [pendingId:number]', '撤回自己的待审投稿')
    .action(async ({ session }, pendingId) => {
      if (pendingId != undefined) {
        pendingId = Math.abs(Math.floor(pendingId))
        return await withdrawPendingSubmission(session, pendingId)
      }
      const mine = pendingRegistry.listByUser(session.userId)
      if (!mine.length) {
        return '你当前没有待审投稿。'
      }
      await session.send(buildAuxiliaryMessage(
        buildPreReviewWithdrawListText(mine, session.platform === 'qq'),
        session.platform,
      ))
      const input = await session.prompt(20000)
      if (input === undefined) {
        await session.send('操作超时，结束处理')
        return
      }
      const withdrawId = Math.floor(Number(input))
      const target = Number.isInteger(withdrawId)
        ? mine.find((record) => record.pendingId === withdrawId)
        : null
      if (!target) {
        await session.send('未命中任意投稿编号，主动操作结束。')
        return
      }
      return await withdrawPendingSubmission(session, target.pendingId)
    })

  ctx
    .command('漂流瓶/漂流瓶统计', '对瓶子生态进行统计')
    .action(async ({ session }) => {
      await sendBottleBundle(session, driftbottle.driftbottleTatistics(session))
    })

  const waitLog = {}
  const historyLog = {}

  ctx
    .command('漂流瓶/漂流瓶日志', '查看漂流瓶历史日志')
    .action(async ({ session }) => {
      if (waitLog[session.userId]) {
        await session.send('请等待请求完成')
        return
      }
      waitLog[session.userId] = true
      try {
        await logs.getUserLogsList(session)
      } finally {
        waitLog[session.userId] = false
      }
    })

  ctx
    .command('漂流瓶/删留言 <bottleId:number>', '对指定评论进行删除')
    .action(async ({ session }, bottleId) => {
      if (bottleId == undefined) {
        return `确认你是否携带瓶子id参数，例如 /删留言 瓶子id`
      }
      driftbottle.delCommentByIdAndIndex(session, bottleId)
    })

  ctx
    .command('漂流瓶/查看瓶子记录', '查看自己获得过的瓶子')
    .action(async ({ session }) => {
      if (historyLog[session.userId]) {
        await session.send('请等待请求完成')
        return
      }
      historyLog[session.userId] = true
      try {
        await driftbottle.getHistoryFormatData(session)
      } finally {
        historyLog[session.userId] = false
      }
    })

  ctx
    .command('漂流瓶/捞云漂流瓶 <num:number>')
    .action(async ({ session }, num) => {
      const type = cooling.check(session.userId, UseType.LaoPingZi)
      if (!type[0]) {
        return `你捞瓶子的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      num = num && Math.abs(Math.floor(num))
      await session.send('稍等，正在向远处的大海祈祷...')
      const { code, data } = await webBottle.getWebBottleData(session, num)
      if (code) {
        reports.rememberCloudBottle(data)
        await sendBottleBundle(
          session,
          await buildCloudBottleMessages(
            data,
            session.platform,
            (ctx as Context & { assets?: AssetTransformer }).assets,
            ctx.http as ImageDataLoader,
          ),
        )
        return
      } else {
        return '获取失败...\n' + data
      }
    })

  ctx
    .command('漂流瓶/扔云漂流瓶 <msgContent:text>', '瓶子将扔向更广阔的大海')
    .action(async ({ session }, msgContent) => {
      const type = cooling.check(session.userId, UseType.RenPingZi)
      if (!type[0]) {
        return `你扔瓶子的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      let res = msgContent || ''
      let imgList = []
      let title = ''

      if (!res.trim()) {
        await session.send('呼呼，您正在尝试向更远的海洋丢出瓶子。这个瓶子将会出现在更多的地方！\n请在60秒内填写自己需要发表的内容。')
        res = await session.prompt(60000)
      }
      if (res && res.trim()) {
        // 判断是否需要添加图片内容
        if (h.select(res, 'img').length == 0) {
          await session.send('需要为该瓶子进行配图吗？请在20秒内发送图片作为补充内容\n不需要则发：否')
          let imgTemp = await session.prompt(20000)
          if (imgTemp !== undefined && imgTemp.trim() !== '否') {
            imgList = imgTemp ? h.select(imgTemp, 'img').map((item) => item.attrs.src) : []
            // 添加图片
            if (imgList.length == 0) {
              await session.send('(；′⌒`) 啊...没检测到图片，图片上传失败')
            }
          }
        } else {
          imgList = h.select(res, 'img').map((item) => item.attrs.src)
        }

        await session.send('需要为该瓶子起一个标题？请在20秒内发送，不需要则发：否')
        const temp_title = await session.prompt(20000)
        if (temp_title && temp_title.trim() !== '否') {
          title = h.select(temp_title, 'text')[0]?.attrs.content
        }
        res = h.select(res, 'text')[0]?.attrs.content
        const temp: BottleContent = {
          content: {
            title,
            text: res,
            image: imgList
          },
          userId: session.userId
        }
        await session.send('请稍等，正在委托船夫驶向远方的大海...')
        const result = await webBottle.setBottleData(session, temp)
        if (result !== -1) {
          return `你的瓶子成功丢进了更深的大海。追踪的ID为：${result}`
        }
        return '扔出失败...'
      }
    })

  ctx
    .command('漂流瓶/云留言 <pid:number> <content:text>')
    .action(async ({ session }, pid, content) => {
      const type = cooling.check(session.userId, UseType.LiuYan)
      if (!type[0]) {
        return `你留言的频率太快，请等${Math.ceil(type[1] / 1000)}秒`
      }
      if (pid == undefined) {
        return `发送失败，请先填写需要留言的漂流瓶的对应 id\n例如：/云留言 1 这是内容`
      }
      pid = Math.abs(Math.floor(pid))
      const text = h.select(content, 'text')[0]?.attrs.content
      const temp: CommentContent = { text, userId: session.userId, platform: session.platform }
      return await webBottle.setCommentData(session, pid, temp)
    })

  ctx
    .command('漂流瓶/批量上传云漂流瓶')
    .action(async ({ session }) => {
      webBottle.uploadWebBottleData(session, driftbottle.GetAllBottle())
    })
}
