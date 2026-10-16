// Executed by the official image's mongosh initialization only on a fresh volume.
const appPassword = process.env.OPENBOARD_MONGO_APP_PASSWORD;
if (!appPassword) throw new Error('OPENBOARD_MONGO_APP_PASSWORD is required');
db.getSiblingDB('openboard').createUser({
  user: 'openboard',
  pwd: appPassword,
  roles: [{ role: 'readWrite', db: 'openboard' }],
});
