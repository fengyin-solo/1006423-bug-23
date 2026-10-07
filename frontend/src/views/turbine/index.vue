<template>
  <section class="page" data-module="turbine">
    <header class="page-head">
      <div>
        <h2>汽轮发电机组管理</h2>
        <p class="page-desc">维护发电机组运行记录，围绕机组编号、机组转速、发电功率、上网电量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发电机组运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出汽轮发电机组清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无汽轮发电机组数据，可先登记发电机组运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 台机组记录（同一机组的重复登记按最近一次解列记录折叠）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-box">
        <header class="modal-head">
          <h3>机组运行详情 · {{ detail.current['机组编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <div class="detail-grid">
          <div v-for="field in detailFields" :key="field" class="detail-item">
            <span class="detail-label">{{ field }}</span>
            <strong class="detail-value">{{ formatCell(detail.current, field) }}</strong>
          </div>
          <div class="detail-item">
            <span class="detail-label">实时运行时长</span>
            <strong class="detail-value">{{ runningHours(detail.current) }}</strong>
          </div>
        </div>
        <h4 class="detail-sub">同一机组历史运行记录</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>并网时间</th>
              <th>解列时间</th>
              <th>本次运行时长</th>
              <th>厂用电量</th>
              <th>记录时间</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in detail.history" :key="String(item.id)">
              <td>{{ item['并网时间'] || '—' }}</td>
              <td>{{ item['解列时间'] || '—' }}</td>
              <td>{{ runningHours(item) }}</td>
              <td>{{ item['厂用电量'] ?? '—' }}</td>
              <td>{{ item['记录时间'] || '—' }}</td>
              <td>{{ item.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  turbineDetail,
  turbineRunningHours,
} from '@/api/local-service'
import { TURBINE_FIELDS } from '@/data/turbine'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('turbine')
// 列表展示字段：状态单独一列渲染，机组状态字段不再重复占列。
const columns = [
  '机组编号',
  '机组转速',
  '发电功率',
  '上网电量',
  '厂用电量',
  '本次运行时长',
  '并网时间',
  '解列时间',
  '运行班次',
  '记录时间',
]
// 状态只能相邻向前，列表上也只给出当前状态允许的动作，避免误点后再报错。
const NEXT_ACTIONS: Record<string, string[]> = {
  待并网: ['提交并网'],
  运行中: ['登记解列'],
  已解列: ['上报故障'],
  故障停机: [],
}
const statuses = ['待并网', '运行中', '已解列', '故障停机']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<{ current: EntryRow; history: EntryRow[] } | null>(null)
const detailFields = TURBINE_FIELDS

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
// 顶部统计卡实算，与状态图例、运营概览的机组数同一口径。
const stats = computed(() => [
  { label: '运行中机组', value: countByStatus('运行中') },
  { label: '已解列机组', value: countByStatus('已解列') },
  { label: '故障停机机组', value: countByStatus('故障停机') },
])

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function availableActions(row: EntryRow): string[] {
  return NEXT_ACTIONS[String(row.status)] ?? []
}

function runningHours(row: EntryRow): string {
  return turbineRunningHours(row)
}

function formatCell(row: EntryRow, column: string): string {
  if (column === '本次运行时长') {
    return runningHours(row)
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '发电机组运行记录登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detail.value = turbineDetail(Number(row.id))
}

function closeDetail() {
  detail.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value) {
    detail.value = turbineDetail(Number(detail.value.current.id))
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汽轮发电机组列表读取失败'
  }
}

onMounted(reload)
</script>
