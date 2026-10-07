import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  POWERSTAT_KEY,
  TURBINE_KEY,
  canonicalRows,
  formatDuration as formatTurbineDuration,
  historyOfUnit,
  recalcPowerstat,
  runTurbineAction,
} from '@/data/turbine'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 机组列表按机组编号去重，同一机组只显示最近一次（解列/故障）记录，
// 列表、详情、运营概览都从这一份代表行取数，口径一致。
export function moduleRows(key: string): EntryRow[] {
  const rows = listRows(key)
  return key === TURBINE_KEY ? canonicalRows(rows) : rows
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(moduleRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 状态机：只能沿登记的状态顺序相邻向前流转，不允许回流，也不允许跳级。
function validateForward(meta: ModuleMeta, current: string, target: string): string | null {
  const fromIndex = meta.statuses.indexOf(current)
  const toIndex = meta.statuses.indexOf(target)
  if (fromIndex < 0 || toIndex < 0) {
    return `${meta.entity}状态「${current}」无法流转到「${target}」`
  }
  if (toIndex === fromIndex) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  if (toIndex < fromIndex) {
    return `${meta.entity}状态只能向前流转，「${current}」之后不能再回到「${target}」`
  }
  if (toIndex !== fromIndex + 1) {
    return `${meta.entity}状态不能跳级：「${current}」需先流转到「${meta.statuses[fromIndex + 1]}」`
  }
  return null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)

  // 机组动作交给域逻辑：状态机校验 + 并网/解列快照落库；解列后联动重算厂用电率。
  if (key === TURBINE_KEY) {
    const result = runTurbineAction(listRows(TURBINE_KEY), id, action)
    if (!result.ok || !result.rows) {
      return result
    }
    saveRows(TURBINE_KEY, result.rows)
    if (action === '登记解列') {
      saveRows(POWERSTAT_KEY, recalcPowerstat(result.rows, listRows(POWERSTAT_KEY)))
    }
    return { ok: true, message: result.message }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const invalid = validateForward(meta, current, target)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 机组详情：代表行与同一机组的全部历史运行记录，转速、时长等与列表同源同值。
export function turbineDetail(id: number): { current: EntryRow; history: EntryRow[] } | null {
  return historyOfUnit(listRows(TURBINE_KEY), id)
}

export function turbineRunningHours(row: EntryRow): string {
  return formatTurbineDuration(row)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of moduleRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 机组模块按机组去重后再计数，与机组列表、详情的机组数保持一致。
    const entries = meta.key === TURBINE_KEY ? canonicalRows(rows[meta.key] ?? []) : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
