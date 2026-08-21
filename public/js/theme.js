(function () {
  try {
    if (localStorage.getItem('diu-theme') === 'bright') {
      document.documentElement.dataset.theme = 'bright';
    }
  } catch (err) {}
})();
