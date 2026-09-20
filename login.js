document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const rememberMe = document.getElementById('remember-me');
  const errorMsg = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');

  // 如果之前选择了“记住状态”，自动填充用户名
  const savedUsername = localStorage.getItem('liquid_admin_username');
  if (savedUsername) {
    usernameInput.value = savedUsername;
    rememberMe.checked = true;
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // 初始化 UI 状态
    errorMsg.style.display = 'none';
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span>身份验证中...</span>';

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    try {
      // 向后端发起登录请求 (使用相对路径 /api/login)
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // 登录成功：存储 Token
        localStorage.setItem('liquid_admin_token', data.token);

        // 处理记住状态
        if (rememberMe.checked) {
          localStorage.setItem('liquid_admin_username', username);
        } else {
          localStorage.removeItem('liquid_admin_username');
        }

        // 跳转主页面
        window.location.href = '/index.html';
      } else {
        // 登录失败：展示错误提示
        errorMsg.textContent = data.message || '用户名或密码错误';
        errorMsg.style.display = 'block';
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<span>登录系统</span>';
      }
    } catch (error) {
      // 网络或服务器异常
      errorMsg.textContent = '网络请求失败，请检查服务状态';
      errorMsg.style.display = 'block';
      loginBtn.disabled = false;
      loginBtn.innerHTML = '<span>登录系统</span>';
    }
  });
});