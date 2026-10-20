// /cc-doc-review 列出本会话文档用的数据整理，全是纯函数；拼成文字在 hooks/register.js 里。

import { ago, dirOf, displayName } from './bandview.js'
import { t } from './i18n.js'

/** @typedef {import('./i18n.js').Lang} Lang */
/** @typedef {{ id: string, path: string, kind?: string, openedAt?: string, modifiedAt?: string, seenAt?: string, pending?: number }} DocSummary */

/** 列表里文档名最多占多宽（中日韩字符算 2）。*/
const NAME_MAX = 32

/** @param {string | undefined} at */
const ms = at => {
  const v = at ? Date.parse(at) : NaN
  return Number.isNaN(v) ? undefined : v
}

/**
 * 列表里的文档项，顺序沿用服务端（最近更新的在前）。
 * isNew：文件修改或登记得比你上次打开文档页晚（没打开过也算新）。
 * @param {DocSummary[] | undefined} summaries @param {string} cwd @param {number} now @param {Lang} [lang]
 */
export function docItems(summaries, cwd, now, lang = 'zh') {
  return (summaries ?? []).map(d => {
    const times = [ms(d.modifiedAt), ms(d.openedAt)].filter(v => v !== undefined)
    const latest = times.length > 0 ? Math.max(...times) : undefined
    const seen = ms(d.seenAt)
    const dir = dirOf(d.path, cwd)
    return {
      id: d.id,
      path: d.path,
      name: displayName(d.path, NAME_MAX),
      dir: dir === './' ? t(lang, 'rootDir') : dir.length > 1 ? dir.slice(0, -1) : dir,
      when: latest === undefined ? '' : ago(new Date(latest).toISOString(), now, lang),
      pending: d.pending ?? 0,
      isNew: seen === undefined || (latest !== undefined && latest > seen),
    }
  })
}
