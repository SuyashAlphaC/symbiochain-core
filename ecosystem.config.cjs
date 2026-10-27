module.exports={apps:[
  {name:'symbio-api',script:'dist/main.js',instances:1,kill_timeout:30000},
  ...['SCOUT','BRAIN','HAND'].map(role=>({name:`symbio-${role.toLowerCase()}`,script:'dist/worker-main.js',instances:1,kill_timeout:60000,env:{WORKER_ROLE:role}})),
]};
