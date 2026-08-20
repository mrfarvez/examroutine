require('dotenv').config();

const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

(async () => {
  const app = await createApp();
  app.listen(PORT, () => {
    console.log(`DIU Exam Schedule Finder running on http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
