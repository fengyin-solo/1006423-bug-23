<template>
  <section class="page" data-module="turbine">
    <header class="page-head">
      <div>
        <h2>机组详情{{ detail ? `：${detail.unit['机组编号']}` : '' }}</h2>
        <p class="page-desc">机组台账与列表、运营概览同源，对不上时以最近一次解列记录为准。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/turbine">返回机组列表</RouterLink>
      </div>
    </header>

    <template v-if="detail">
      <dl class="detail-grid">
        <div v-for="field in fields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>{{ detail.unit[field] ?? '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>当前状态</dt>
          <dd>{{ detail.unit.status }}</dd>
        </div>
      </dl>

      <h3 class="section-title">状态流转记录</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录时间</th>
            <th>并网时间</th>
            <th>解列时间</th>
            <th>本次运行时长</th>
            <th>厂用电量</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in detail.history" :key="String(row.id)">
            <td>{{ row['记录时间'] ?? '—' }}</td>
            <td>{{ row['并网时间'] ?? '—' }}</td>
            <td>{{ row['解列时间'] ?? '—' }}</td>
            <td>{{ row['本次运行时长'] ?? '—' }}</td>
            <td>{{ row['厂用电量'] ?? '—' }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
    </template>
    <p v-else class="empty-state">没有找到对应的机组记录，可能已被清理。</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { getTurbineUnitDetail, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

type UnitDetail = { unit: EntryRow; history: EntryRow[] }

const route = useRoute()
const meta = moduleMeta('turbine')
const fields = meta.fields
const detail = ref<UnitDetail | null>(null)

onMounted(() => {
  detail.value = getTurbineUnitDetail(Number(route.params.id))
})
</script>
