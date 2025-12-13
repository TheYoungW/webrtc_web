import { createRouter, createWebHistory } from 'vue-router';
import Master from '../components/Master.vue';
import Slave from '../components/Slave.vue';

const routes = [
    { path: '/', redirect: '/master' },
    { path: '/master', component: Master },
    { path: '/slave', component: Slave },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
});

export default router;
