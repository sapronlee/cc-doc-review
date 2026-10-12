// 评论送达：重试时序、附在用户消息上的文字、自动提醒的名单和提示文案。全是纯函数；投递流程在 hooks/register.js 里。

/** 发进会话失败后，第 1、2、3 次重试前各等多久。*/
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000]

/**
 * 第 failures 次失败后等多久再试；重试用完返回 undefined（改为附在用户的下一条消息上）。
 * @param {number} failures 已失败的次数
 */
export function retryDelay(failures) {
  return failures >= 1 ? RETRY_DELAYS_MS[failures - 1] : undefined
}

/** 用户自己发的消息：输入框回车、Remote Control、SDK 宿主（桌面版）。插件发的（含本插件）、通知、别的会话都不算。*/
const USER_KINDS = new Set(['composer', 'bridge', 'sdk'])

/** @param {{ kind: string } | undefined} origin prompt.submit 的 e.origin */
export function isUserOrigin(origin) {
  return USER_KINDS.has(origin?.kind ?? '')
}

/**
 * 附在用户消息上（context）的文字：说明来由，后面接各批评论（formatBatch 排好的）。
 * @param {string[]} batches
 */
export function contextText(batches) {
  return ['以下是用户在文档评审页发送、之前没能及时送达的评论，请和这条消息一起处理：', ...batches].join('\n\n')
}

/** @param {number} n */
export function deliveredToast(n) {
  return `已收到 ${n} 条评论，Claude 正在处理`
}

/** @param {number} n */
export function queuedToast(n) {
  return `${n} 条评论暂时发不进会话，会附在你的下一条消息上交给 Claude`
}

/** @param {number} n */
export function remindedToast(n) {
  return `还有 ${n} 条评论没回复处理结果，已提醒 Claude`
}

/** @param {number} n */
export function remindFailedToast(n) {
  return `还有 ${n} 条评论没回复处理结果，没能提醒 Claude，请提醒它调用 review_resolve`
}

/**
 * 一轮结束时要不要自动提醒：没回复的评论里有属于还没提醒过的批次的，就提醒全部没回复的，并记下那些批次；
 * 都提醒过了就不提醒（每批最多一次，防止循环）。
 * @param {string[]} pending 没回复的评论 ID
 * @param {Map<string, string>} batchOf 评论 ID → 批次 ID
 * @param {Set<string>} reminded 已提醒过的批次
 * @returns {{ ids: string[], batches: string[] }}
 */
export function reminderTargets(pending, batchOf, reminded) {
  const batches = [...new Set(pending.map(id => batchOf.get(id) ?? id))].filter(b => !reminded.has(b))
  return batches.length > 0 ? { ids: [...pending], batches } : { ids: [], batches: [] }
}

/** 「通过」消息送达时的提示。@param {string} name 文件名 */
export function approvedToast(name) {
  return `已通知 Claude：${name} 已通过评审`
}

/** 「通过」消息暂时发不进会话时的提示。@param {string} name 文件名 */
export function approveQueuedToast(name) {
  return `${name} 已通过，但通知暂时发不进会话，会附在你的下一条消息上告诉 Claude`
}
