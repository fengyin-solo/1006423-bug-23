import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Weighbridge = () => import('@/views/weighbridge/index.vue')
const Pit = () => import('@/views/pit/index.vue')
const Incinerator = () => import('@/views/incinerator/index.vue')
const Boiler = () => import('@/views/boiler/index.vue')
const Turbine = () => import('@/views/turbine/index.vue')
const TurbineDetail = () => import('@/views/turbine/detail.vue')
const Fluegas = () => import('@/views/fluegas/index.vue')
const Cems = () => import('@/views/cems/index.vue')
const Flyash = () => import('@/views/flyash/index.vue')
const Slag = () => import('@/views/slag/index.vue')
const Leachate = () => import('@/views/leachate/index.vue')
const Equipcheck = () => import('@/views/equipcheck/index.vue')
const Overhaul = () => import('@/views/overhaul/index.vue')
const Spare = () => import('@/views/spare/index.vue')
const Powerstat = () => import('@/views/powerstat/index.vue')
const Emission = () => import('@/views/emission/index.vue')
const Shift = () => import('@/views/shift/index.vue')
const Safetyplan = () => import('@/views/safetyplan/index.vue')
const Training = () => import('@/views/training/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/weighbridge', name: 'weighbridge', component: Weighbridge },
    { path: '/pit', name: 'pit', component: Pit },
    { path: '/incinerator', name: 'incinerator', component: Incinerator },
    { path: '/boiler', name: 'boiler', component: Boiler },
    { path: '/turbine', name: 'turbine', component: Turbine },
    { path: '/turbine/:id', name: 'turbine-detail', component: TurbineDetail },
    { path: '/fluegas', name: 'fluegas', component: Fluegas },
    { path: '/cems', name: 'cems', component: Cems },
    { path: '/flyash', name: 'flyash', component: Flyash },
    { path: '/slag', name: 'slag', component: Slag },
    { path: '/leachate', name: 'leachate', component: Leachate },
    { path: '/equipcheck', name: 'equipcheck', component: Equipcheck },
    { path: '/overhaul', name: 'overhaul', component: Overhaul },
    { path: '/spare', name: 'spare', component: Spare },
    { path: '/powerstat', name: 'powerstat', component: Powerstat },
    { path: '/emission', name: 'emission', component: Emission },
    { path: '/shift', name: 'shift', component: Shift },
    { path: '/safetyplan', name: 'safetyplan', component: Safetyplan },
    { path: '/training', name: 'training', component: Training },
  ],
})

export default router
