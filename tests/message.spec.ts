import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import type { DiftInfo } from '../src'
import {
  buildLocalBottleMessages,
  buildMainMenuBundle,
  buildMarkdownImage,
  createMainKeyboard,
} from '../src/message'

test('QQ markdown image contains required width and height mapping', () => {
  assert.equal(
    buildMarkdownImage('https://assets.example/bottle.jpg', '漂流瓶图片'),
    '![漂流瓶图片 #1024px #1024px](https://assets.example/bottle.jpg)',
  )
  assert.throws(
    () => buildMarkdownImage('https://assets.example/bottle.jpg', '漂流瓶图片', 0, 1024),
    RangeError,
  )
})

test('local QQ bottle uses mapped Assets URL and does not resend the embedded image', async () => {
  const bottle: DiftInfo = {
    id: 12,
    style: 0,
    content: {
      creatTime: 1_700_000_000_000,
      text: '图片测试',
      image: ['file:///C:/data/a.jpg'],
      audio: null,
      title: '测试瓶',
    },
    getCount: 1,
    show: true,
    userId: '10001',
    review: [],
  }
  const bundle = await buildLocalBottleMessages(bottle, 'qq', {
    async transform(content: string) {
      assert.equal(h.parse(content)[0].attrs.src, 'file:///C:/data/a.jpg')
      return h.image('https://assets.example/bottle.jpg').toString()
    },
  })
  const markdown = bundle.primary.attrs.markdown.content
  assert.equal(markdown.includes('![漂流瓶图片 1 #1024px #1024px](https://assets.example/bottle.jpg)'), true)
  assert.equal(markdown.includes('file:///'), false)
  assert.equal(bundle.media.some(element => element.type === 'img'), false)
})

test('main command uses QQ markdown with a six-button keyboard', () => {
  const keyboard = createMainKeyboard()
  assert.deepEqual(keyboard.content.rows.flatMap(row => row.buttons).map(button => button.render_data.label), [
    '捞漂流瓶', '扔漂流瓶', '捞云漂流瓶', '扔云漂流瓶', '查看记录', '查看日志',
  ])
  assert.equal(keyboard.content.rows[0].buttons[1].action.data, '扔漂流瓶 ')
  assert.equal(keyboard.content.rows[0].buttons[1].action.enter, false)
  assert.equal(keyboard.content.rows[1].buttons[1].action.data, '扔云漂流瓶 ')
  assert.equal(keyboard.content.rows[1].buttons[1].action.enter, false)
  assert.equal(buildMainMenuBundle('qq').primary.type, 'qq:rawmarkdown')
  assert.equal(buildMainMenuBundle('onebot').primary.type, 'message')
})
