require('dotenv').config();
const { createApp } = require('../app');

let cachedApp = null;
let initPromise = null;

function getApp() {
  if (!cachedApp) {
    if (!initPromise) {
      initPromise = createApp()
        .then((app) => { cachedApp = app; })
        .catch((e) => { initPromise = null; throw e; });
    }
    return initPromise.then(() => cachedApp);
  }
  return Promise.resolve(cachedApp);
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (e) {
    console.error('[init]', e && e.message ? e.message : e);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Service warming up, please retry in a moment' }));
    } else {
      res.end();
    }
  }
};
