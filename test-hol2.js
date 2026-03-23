require('dotenv').config();
const hol = require('./src/server/integrations/hol.js');
console.log('starting hol');
hol.ensureHolAgentRegistration('http://localhost:3000')
.then(r => console.log('success', r))
.catch(e => console.log('error', e));
