require('dotenv').config();
const hol = require('./src/server/integrations/hol.js');
hol.ensureHolAgentRegistration('http://localhost:3000').then(console.log).catch(console.error);
