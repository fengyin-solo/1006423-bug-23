import type { ActionResult, EntryRow } from './types'

// 汽轮发电机组域逻辑：状态机、并网/解列快照、按机组去重、厂用电率重算都集中在这里，
// 列表、详情、运营概览、发电量统计统一走这一份，口径不再各算各的。

export const TURBINE_KEY = 'turbine'
export const POWERSTAT_KEY = 'powerstat'

// 状态只能沿这个顺序相邻向前：待并网 → 运行中 → 已解列 → 故障停机。
export const TURBINE_STATUSES = ['待并网', '运行中', '已解列', '故障停机'] as const
const TERMINAL_STATUSES = ['已解列', '故障停机']

export const TURBINE_ACTION_TARGETS: Record<string, string> = {
  提交并网: '运行中',
  登记解列: '已解列',
  上报故障: '故障停机',
}

// 并网后的额定工况：演示数据没有录入表单，动作触发时按额定值固化快照。
export const RATED_SPEED = 3000 // 机组转速 r/min
export const RATED_POWER = 15000 // 发电功率 kW
// 解列时按本次发电量折算厂用电量的经验系数，发电量统计的厂用电率也用同一口径。
export const STATION_USE_RATE = 0.08

export const TURBINE_FIELDS = [
  '机组编号',
  '机组转速',
  '发电功率',
  '上网电量',
  '厂用电量',
  '发电量',
  '运行班次',
  '记录时间',
  '机组状态',
  '并网时间',
  '解列时间',
  '本次运行时长',
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function toNumber(value: unknown): number {
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 代表行排序用的时间戳：终态时间优先，其次并网时间，最后登记时的记录时间。
function timeKey(row: EntryRow): number {
  const raw = row['解列时间'] || row['并网时间'] || row['记录时间']
  const ms = Date.parse(String(raw ?? ''))
  return Number.isNaN(ms) ? 0 : ms
}

// 生命周期优先级：故障停机 > 已解列 > 运行中 > 待并网。
// 同一机组的记录对不上时，已走到终态（即最近一次解列）的记录才是准的，
// 重复提交并网产生的新待并网记录不能把在运/已停的机组盖掉。
function lifecycleRank(row: EntryRow): number {
  switch (String(row.status)) {
    case '故障停机':
      return 3
    case '已解列':
      return 2
    case '运行中':
      return 1
    default:
      return 0
  }
}

function unitCode(row: EntryRow): string {
  return String(row['机组编号'] ?? row.id)
}

// 同一机组的多次运行记录只保留一台：先按生命周期取最靠后的状态，
// 同一层级再取时间最新的一条——即「以最近一次解列记录为准」。
// 故障停机的机组不会再以旧的运行中记录在列表里重复出现。
export function canonicalRows(rows: EntryRow[]): EntryRow[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const code = unitCode(row)
    const list = groups.get(code)
    if (list) {
      list.push(row)
    } else {
      groups.set(code, [row])
    }
  }
  const representatives: EntryRow[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a, b) => lifecycleRank(a) - lifecycleRank(b) || timeKey(a) - timeKey(b),
    )
    representatives.push(sorted[sorted.length - 1])
  }
  return representatives.sort(
    (a, b) => lifecycleRank(a) - lifecycleRank(b) || timeKey(a) - timeKey(b),
  )
}

// 详情用：同一机组的全部运行记录（含被代表行折叠掉的历史），按时间正序。
export function historyOfUnit(rows: EntryRow[], id: number): { current: EntryRow; history: EntryRow[] } | null {
  const representative = canonicalRows(rows).find((row) => Number(row.id) === id)
  if (!representative) {
    return null
  }
  const history = rows
    .filter((row) => unitCode(row) === unitCode(representative))
    .sort((a, b) => timeKey(a) - timeKey(b) || lifecycleRank(a) - lifecycleRank(b))
  return { current: representative, history }
}

// 运行时长：运行中按并网时间实时累计；已解列/故障停机只读解列时冻结的「本次运行时长」，
// 解列之后再也不会照着老记录往上加。
export function formatDuration(row: EntryRow, nowMs: number = Date.now()): string {
  const status = String(row.status)
  if (status === '待并网') {
    return '—'
  }
  if (TERMINAL_STATUSES.includes(status)) {
    return `${toNumber(row['本次运行时长']).toFixed(2)} 小时`
  }
  const startMs = Date.parse(String(row['并网时间'] || row['记录时间'] || ''))
  if (Number.isNaN(startMs)) {
    return '—'
  }
  return `${round2(Math.max(0, (nowMs - startMs) / 3600000)).toFixed(2)} 小时`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

export type TurbineActionResult = ActionResult & { rows?: EntryRow[] }

// 机组动作：先卡状态机（不许回流、不许跳级），再把该落库的快照一次性写齐。
export function runTurbineAction(
  rows: EntryRow[],
  id: number,
  action: string,
  nowMs: number = Date.now(),
): TurbineActionResult {
  const target = TURBINE_ACTION_TARGETS[action]
  if (!target) {
    return fail(`发电机组运行记录没有登记「${action}」这个动作`)
  }
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的发电机组运行记录`)
  }
  const row = rows[index]
  const current = String(row.status)
  const fromIndex = TURBINE_STATUSES.indexOf(current as (typeof TURBINE_STATUSES)[number])
  const toIndex = TURBINE_STATUSES.indexOf(target as (typeof TURBINE_STATUSES)[number])

  if (fromIndex === -1 || toIndex === -1) {
    return fail(`机组状态「${current}」无法执行「${action}」`)
  }
  if (toIndex === fromIndex) {
    return fail(`机组已经是「${target}」，不用重复操作`)
  }
  if (toIndex < fromIndex) {
    return fail(`机组状态只能从待并网依次走到故障停机，「${current}」之后不能再回到「${target}」`)
  }
  if (toIndex !== fromIndex + 1) {
    return fail(`机组状态不能跳级：「${current}」需先流转到「${TURBINE_STATUSES[fromIndex + 1]}」`)
  }

  // 同一机组同一时段（上一次并网还没走到终态）重复提交并网，只生效一次。
  // 直接扫全部记录而不是只看代表行：重复登记的新记录可能把旧的运行中记录挤出代表行。
  if (action === '提交并网') {
    const code = unitCode(row)
    const duplicated = rows.some(
      (item) =>
        item !== row &&
        unitCode(item) === code &&
        String(item['并网时间'] || '') !== '' &&
        !TERMINAL_STATUSES.includes(String(item.status)),
    )
    if (duplicated) {
      return fail(`机组 ${code} 当前时段已并网，重复提交并网只生效一次`)
    }
  }

  const now = formatTime(nowMs)
  let updated: EntryRow

  if (action === '提交并网') {
    updated = {
      ...row,
      status: '运行中',
      pending: true,
      abnormal: false,
      机组转速: RATED_SPEED,
      发电功率: RATED_POWER,
      发电量: 0,
      厂用电量: 0,
      上网电量: 0,
      并网时间: row['并网时间'] || now,
      解列时间: '',
      本次运行时长: 0,
      记录时间: row['记录时间'] || now,
      机组状态: '运行中',
    }
  } else if (action === '登记解列') {
    // 解列这一步把解列时间、本次运行时长、发电量/厂用电量/上网电量一并落库，
    // 刷新或重新进入页面读到的都是这一份冻结快照。
    const startRaw = String(row['并网时间'] || row['记录时间'] || '')
    const startMs = Date.parse(startRaw)
    const elapsed = Number.isNaN(startMs)
      ? 0
      : round2(Math.max(0, (nowMs - startMs) / 3600000))
    const generation = Math.round(toNumber(row['发电功率']) * elapsed)
    const stationUse = Math.round(generation * STATION_USE_RATE)
    updated = {
      ...row,
      status: '已解列',
      pending: false,
      abnormal: false,
      机组转速: 0,
      发电功率: 0,
      发电量: generation,
      厂用电量: stationUse,
      上网电量: generation - stationUse,
      并网时间: row['并网时间'] || startRaw,
      解列时间: now,
      本次运行时长: elapsed,
      机组状态: '已解列',
    }
  } else {
    // 上报故障只能从已解列相邻过来；解列快照已在解列时落库，这里只补故障标记与时间。
    updated = {
      ...row,
      status: '故障停机',
      pending: false,
      abnormal: true,
      机组状态: '故障停机',
      故障时间: now,
    }
  }

  const next = [...rows]
  next[index] = updated
  return { ok: true, message: `发电机组已${action}，当前状态「${target}」`, rows: next }
}

// 机组解列后，发电量统计按全部已终态机组的本次快照重算厂用电率，
// 发电量、上网电量同步为同一口径的汇总值；待填报的周期不替用户填报。
export function recalcPowerstat(turbineRows: EntryRow[], statRows: EntryRow[]): EntryRow[] {
  const finished = canonicalRows(turbineRows).filter((row) =>
    TERMINAL_STATUSES.includes(String(row.status)),
  )
  const generation = finished.reduce((sum, row) => sum + toNumber(row['发电量']), 0)
  const stationUse = finished.reduce((sum, row) => sum + toNumber(row['厂用电量']), 0)
  const onGrid = finished.reduce((sum, row) => sum + toNumber(row['上网电量']), 0)
  const rate = generation > 0 ? `${((stationUse / generation) * 100).toFixed(2)}%` : '—'

  return statRows.map((row) => {
    if (!['已填报', '已审核'].includes(String(row.status))) {
      return row
    }
    return {
      ...row,
      发电量: String(generation),
      上网电量: String(onGrid),
      厂用电率: rate,
    }
  })
}
