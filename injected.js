// --- START OF FILE injected.js ---

(function() {
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const response = await originalFetch(...args);

    // Проверяем, тот ли это URL (отправка задачи)
    if (args[0] && typeof args[0] === 'string' && args[0].includes('/task/v2/submit')) {

      const clone = response.clone();

      clone.json().then(body => {
        // Логируем ответ
        // console.log('[DreamFace Spy] Ответ сервера:', body);

        // 1. ПРОВЕРКА НА УСПЕХ (Добавлено)
        // Судя по логам, сервер возвращает: {status_code: 'THS12140000000', status_msg: 'Success', ...}
        if (body && (body.status_msg === 'Success' || body.status_msg === 'success')) {
           console.log('%c[DreamFace Spy] УСПЕХ: Задача принята сервером!', 'color: green');
           window.dispatchEvent(new CustomEvent('DreamFaceTaskSuccess'));
           return;
        }

        // 2. ПРОВЕРКА НА ОШИБКУ (Лимит)
        const jsonString = JSON.stringify(body).toLowerCase();
        const isLimit =
          jsonString.includes('10 tasks') ||
          jsonString.includes('processing your existing') ||
          jsonString.includes('limit reached');

        if (isLimit) {
          console.warn('[DreamFace Spy] ПОЙМАН ЛИМИТ ЗАДАЧ!');
          window.dispatchEvent(new CustomEvent('DreamFaceLimitHit'));
        }

      }).catch(err => {
        // Ошибки парсинга
      });
    }

    return response;
  };
})();
