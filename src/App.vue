<template>
  <div class="app-container">
    <header class="navbar">
      <div class="nav-content">
        <div class="logo">TeleOp<span class="highlight">Pro</span></div>
        <nav>
          <router-link to="/master" class="nav-link">示教臂</router-link>
          <router-link to="/slave" class="nav-link">操作臂</router-link>
        </nav>
      </div>
    </header>
    
    <main class="main-content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  z-index: 1000;
  display: flex;
  justify-content: center;
}

.nav-content {
  width: 100%;
  max-width: 1000px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}

.logo {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.5px;
}

.highlight {
  color: var(--accent-color);
}

.nav-link {
  color: var(--text-secondary);
  text-decoration: none;
  font-weight: 500;
  margin-left: 24px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: all 0.2s;
}

.nav-link:hover {
  color: var(--text-primary);
  background: rgba(0, 0, 0, 0.03);
}

.nav-link.router-link-active {
  color: var(--accent-color);
  background: rgba(0, 113, 227, 0.1);
}

.main-content {
  margin-top: 60px;
  padding: 40px 20px;
  flex: 1;
  display: flex;
  justify-content: center;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
