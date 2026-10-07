import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta } from '@/data/types'

// 汽轮发电机组的专用规则：状态只能顺着走、解列落库、按机组口径汇总、解列后联动重算厂用电率。
// 页面不直接引用这里，统一由 local-service.ts 调用。

export const TURBINE_KEY = 'turbine'
export const POWERSTAT_KEY = 'powerstat'
export const GRID_ACTION = '提交并网'
export const SETTLE_ACTION = '登记解列'

// 机组台账里的中文字段名
export const TURBINE_FIELD = {
  unit: '机组编号',
  shift: '运行班次',
  recordDate: '记录时间',
  gridConnectedAt: '并网时间',
  settledAt: '解列时间',
  runHours: '本次运行时长',
  plantUsage: '厂用电量',
  gridEnergy: '上网电量',
  power: '发电功率',
} as const

const POWERSTAT_FIELD = { generated: '发电量', gridEnergy: '上网电量', plantRate: '厂用电率' } as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const text = value.trim().replace(' ', 'T')
  const withTime = text.includes('T') ? text : `${text}T00:00`
  const time = new Date(withTime).getTime()
  return Number.isNaN(time) ? null : time
}

// 只认纯数字（允许小数），「汽轮发电机组样例2」这类占位文本不参与计算
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return null
  }
  return Number(text)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 状态机：只能按 statuses 的顺序一步一步往前走，回退和跳级都拦下；同一机组同一时段并网只生效一次。
// 返回 null 表示放行，否则直接返回失败原因。
export function guardTurbineTransition(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult | null {
  const order = meta.statuses
  const row = rows[index]
  const current = String(row.status)
  const from = order.indexOf(current)
  const to = order.indexOf(target)
  if (from < 0 || to < 0) {
    return null
  }
  if (to < from) {
    return {
      ok: false,
      message: `机组状态不能从「${current}」回退到「${target}」：状态只能顺着走，解列后不能再回到运行中`,
    }
  }
  if (to > from + 1) {
    return {
      ok: false,
      message: `机组状态不能从「${current}」直接跳到「${target}」，只能顺着走到「${order[from + 1]}」，不许跳级`,
    }
  }
  if (action === GRID_ACTION) {
    const duplicated = rows.some((other, otherIndex) => {
      if (otherIndex === index) {
        return false
      }
      const sameUnit = String(other[TURBINE_FIELD.unit] ?? '') === String(row[TURBINE_FIELD.unit] ?? '')
      const samePeriod =
        String(other[TURBINE_FIELD.recordDate] ?? '') === String(row[TURBINE_FIELD.recordDate] ?? '') &&
        String(other[TURBINE_FIELD.shift] ?? '') === String(row[TURBINE_FIELD.shift] ?? '')
      const alreadyConnected =
        Boolean(other[TURBINE_FIELD.gridConnectedAt]) || String(other.status) !== order[0]
      return sameUnit && samePeriod && alreadyConnected
    })
    if (duplicated) {
      return {
        ok: false,
        message: `机组「${String(row[TURBINE_FIELD.unit])}」在 ${String(row[TURBINE_FIELD.recordDate])} ${String(row[TURBINE_FIELD.shift])} 已提交过并网，同一时段重复提交只生效一次`,
      }
    }
  }
  return null
}

// 动作落库：并网记并网时间；解列把解列时间、本次运行时长、厂用电量一并落下，
// 运行时长在解列这一刻算定并冻结，之后不再照着老记录往上加。
export function applyTurbineAction(row: EntryRow, action: string, now: Date = new Date()): EntryRow {
  if (action === GRID_ACTION) {
    return { ...row, [TURBINE_FIELD.gridConnectedAt]: formatTimestamp(now) }
  }
  if (action === SETTLE_ACTION) {
    const settledAt = formatTimestamp(now)
    const startedAt =
      parseTime(row[TURBINE_FIELD.gridConnectedAt]) ?? parseTime(row[TURBINE_FIELD.recordDate])
    const hours = startedAt === null ? 0 : round2(Math.max(0, (now.getTime() - startedAt) / 3_600_000))
    const updated: EntryRow = {
      ...row,
      [TURBINE_FIELD.settledAt]: settledAt,
      [TURBINE_FIELD.runHours]: hours,
    }
    const usage = settlePlantUsage(row, hours)
    if (usage !== null) {
      updated[TURBINE_FIELD.plantUsage] = usage
    }
    return updated
  }
  return row
}

// 本次厂用电量 = 发电功率 × 本次运行时长 − 上网电量；字段不是数值时保留原值
function settlePlantUsage(row: EntryRow, hours: number): number | null {
  const power = toNumber(row[TURBINE_FIELD.power])
  const onGrid = toNumber(row[TURBINE_FIELD.gridEnergy])
  if (power === null || onGrid === null) {
    return null
  }
  return round2(Math.max(0, power * hours - onGrid))
}

// 机组口径：同一机组可能有多条记录，以最近一次解列记录为准（没有解列记录就看记录时间，再按编号兜底）
function recencyOf(row: EntryRow): string {
  return String(row[TURBINE_FIELD.settledAt] ?? row[TURBINE_FIELD.recordDate] ?? '')
}

export function deriveTurbineUnits(rows: EntryRow[]): EntryRow[] {
  const latestByUnit = new Map<string, EntryRow>()
  for (const row of rows) {
    const unitKey = String(row[TURBINE_FIELD.unit] ?? row.id)
    const prev = latestByUnit.get(unitKey)
    if (!prev) {
      latestByUnit.set(unitKey, row)
      continue
    }
    const recency = recencyOf(row).localeCompare(recencyOf(prev))
    if (recency > 0 || (recency === 0 && Number(row.id) > Number(prev.id))) {
      latestByUnit.set(unitKey, row)
    }
  }
  return [...latestByUnit.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

export function getTurbineUnitDetail(id: number): { unit: EntryRow; history: EntryRow[] } | null {
  const rows = listRows(TURBINE_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const unitKey = String(row[TURBINE_FIELD.unit] ?? row.id)
  const history = rows
    .filter((item) => String(item[TURBINE_FIELD.unit] ?? item.id) === unitKey)
    .sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)) || Number(b.id) - Number(a.id))
  const unit =
    deriveTurbineUnits(rows).find(
      (item) => String(item[TURBINE_FIELD.unit] ?? item.id) === unitKey,
    ) ?? row
  return { unit, history }
}

// 机组解列后联动：发电量统计的厂用电率跟着重算。
// 优先用已解列机组落库的厂用电量/上网电量汇总成全厂口径；没有数值时退回按各行自身的发电量/上网电量重算。
export function recalcPowerstatRate(): void {
  const rows = listRows(POWERSTAT_KEY)
  if (rows.length === 0) {
    return
  }
  const settled = listRows(TURBINE_KEY).filter((row) => Boolean(row[TURBINE_FIELD.settledAt]))
  const usageTotal = sumField(settled, TURBINE_FIELD.plantUsage)
  const gridTotal = sumField(settled, TURBINE_FIELD.gridEnergy)
  const fleetRate =
    usageTotal !== null && gridTotal !== null && usageTotal + gridTotal > 0
      ? (usageTotal / (usageTotal + gridTotal)) * 100
      : null
  let changed = false
  const next = rows.map((row) => {
    let rate = fleetRate
    if (rate === null) {
      const generated = toNumber(row[POWERSTAT_FIELD.generated])
      const onGrid = toNumber(row[POWERSTAT_FIELD.gridEnergy])
      if (generated !== null && generated > 0 && onGrid !== null) {
        rate = ((generated - onGrid) / generated) * 100
      }
    }
    if (rate === null) {
      return row
    }
    const text = `${rate.toFixed(2)}%`
    if (row[POWERSTAT_FIELD.plantRate] === text) {
      return row
    }
    changed = true
    return { ...row, [POWERSTAT_FIELD.plantRate]: text }
  })
  if (changed) {
    saveRows(POWERSTAT_KEY, next)
  }
}

function sumField(rows: EntryRow[], field: string): number | null {
  let total = 0
  let found = false
  for (const row of rows) {
    const value = toNumber(row[field])
    if (value !== null) {
      total += value
      found = true
    }
  }
  return found ? total : null
}
