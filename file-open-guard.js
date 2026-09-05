if (window.location.protocol === 'file:') {
  window.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = `
      <main class="file-open-page">
        <section class="file-open-card">
          <h1>需要先启动本地服务</h1>
          <p>这个产品包含真实模型调用、素材保存和生成记录，不能直接双击 HTML 文件运行。请回到项目文件夹，双击下面的启动文件；启动后会自动打开可用页面。</p>
          <code>启动 AI 商品图生成器.command</code>
          <p>也可以在终端运行：npm start</p>
        </section>
      </main>
    `
  }, { once: true })
}
