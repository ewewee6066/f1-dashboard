// Private, account-scoped favourites. Public F1 data remains shared and cacheable.
export function createF1Preferences({db,requireUser,jsonBody,send}) {
  db.exec('CREATE TABLE IF NOT EXISTS f1_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, driver_id TEXT, constructor_id TEXT)');
  const read=db.prepare('SELECT driver_id AS driverId, constructor_id AS constructorId FROM f1_preferences WHERE user_id=?');
  const write=db.prepare('INSERT INTO f1_preferences VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET driver_id=excluded.driver_id, constructor_id=excluded.constructor_id');
  const valid=value=>value===null||value===''||typeof value==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value);
  return async(req,res,url)=>{
    if(url.pathname!=='/api/account/f1-preferences')return false;
    const session=requireUser(req);
    if(req.method==='GET')send(res,200,read.get(session.user_id)||{driverId:null,constructorId:null});
    else if(req.method==='PUT') {
      const body=await jsonBody(req);
      if(!body||!valid(body.driverId)||!valid(body.constructorId))throw Object.assign(new Error('请选择有效的车手和车队'),{status:400});
      write.run(session.user_id,body.driverId||null,body.constructorId||null);
      send(res,200,read.get(session.user_id));
    }else send(res,405,{error:'不支持此操作'});
    return true;
  };
}
