import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNavigationRouter, evaluateNavigation, validatePlan } from '../navigationFeatures.js';
import { createChoiceStore, routeKey } from '../routeChoiceStore.js';
import { mapPointCollection } from '../nightMapPoints.js';

const route = (via=25.048, minutes=10) => ({ expectedMin: minutes, geometry: {
  type: 'LineString', coordinates: [[121.517,25.047],[121.521,via],[121.525,25.049]] } });
const body = { participantId: 'test-device-00000001', mode: 'walk', night: false, distribution: true, routes: [route(),route(25.052,12)] };
async function harness(t, scoreRoutes = async routes => routes.map((_,i) => ({ status:'ok',score:80-i }))) {
  let clock=1_000_000;
  const store=createChoiceStore(':memory:');
  const app=express(); app.use('/api/navigation',createNavigationRouter({ store,scoreRoutes,now:()=>clock }));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(async()=>{ await new Promise(r=>server.close(r)); store.close(); });
  return { store, advance:n=>{clock+=n;}, async post(endpoint,data) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/navigation/${endpoint}`, {
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data) });
    return { status:response.status,data:await response.json() };
  } };
}
test('shared counts, duplicate confirmation, switch, history and expiry',async t=>{
  const h=await harness(t);
  const a=(await h.post('analyze',body)).data;
  const b=(await h.post('analyze',{...body,participantId:'test-device-00000002'})).data;
  assert.equal(a.routes[0].count,0);
  const choice={participantId:body.participantId,planId:a.planId,routeKey:a.routes[0].key};
  const first=(await h.post('choice',choice)).data;
  assert.equal(first.routes[0].count,1); assert.equal(first.change.changed,true);
  assert.ok(first.routes[0].model.total>first.before[0].model.total);
  h.advance(300000);
  const replay=(await h.post('choice',choice)).data;
  assert.equal(replay.change.changed,false); assert.equal(replay.choiceExpiresAt,first.choiceExpiresAt);
  const other=(await h.post('status',{participantId:'test-device-00000002',planId:b.planId})).data;
  assert.equal(other.routes[0].count,1);
  const switched=(await h.post('choice',{...choice,routeKey:a.routes[1].key})).data;
  assert.deepEqual(switched.routes.map(r=>r.count),[0,1]);
  assert.equal(switched.choiceExpiresAt,first.choiceExpiresAt);
  const log=(await h.post('history',{participantId:body.participantId})).data.events;
  assert.equal(log.length,2); assert.equal(log[0].previous_route,a.routes[0].key);
  assert.equal(log[0].decision.label,'路線 B');
  assert.deepEqual(log[0].geometry,body.routes[1].geometry);
  assert.equal(log[0].mode,'walk');
  h.advance(300000);
  const expired=(await h.post('status',{participantId:body.participantId,planId:a.planId})).data;
  assert.deepEqual(expired.routes.map(r=>r.count),[0,0]);
  assert.equal(expired.choiceExpiresAt,null);
});
test('concurrent confirmations are idempotent and persist after reopening database',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'risknav-test-'));
  const file=path.join(dir,'choices.sqlite');
  let store=createChoiceStore(file);
  try {
    const input={participant:'a',journey:'j',routeKey:'r',now:1,decision:{label:'A'}};
    const results=await Promise.all(Array.from({length:10},()=>Promise.resolve().then(()=>store.choose(input))));
    assert.equal(results.filter(r=>r.changed).length,1);
    store.close(); store=createChoiceStore(file);
    assert.equal(store.counts(['r'],2).r,1);assert.equal(store.history('a').length,1);
  } finally { store.close();rmSync(dir,{recursive:true,force:true}); }
});
test('counts follow geometry and mode rather than A/B ordering',async t=>{
  const h=await harness(t), first=(await h.post('analyze',body)).data;
  await h.post('choice',{participantId:body.participantId,planId:first.planId,routeKey:first.routes[0].key});
  const second=(await h.post('analyze',{...body,routes:[...body.routes].reverse()})).data;
  assert.deepEqual(second.routes.map(r=>r.count),[0,1]);assert.equal(second.routes[1].selected,true);
  assert.notEqual(routeKey(route(),'walk'),routeKey(route(),'car'));
  assert.notEqual(routeKey(route(),'walk'),routeKey({...route(),geometry:{type:'LineString',coordinates:route().geometry.coordinates.toReversed()}},'walk'));
  const subdivided=route();subdivided.geometry.coordinates.splice(1,0,[121.519,25.0475]);
  assert.equal(routeKey(subdivided,'walk'),routeKey(route(),'walk'));
});
test('missing scores never become zero risk or a night recommendation',async t=>{
  const h=await harness(t,async()=>[{score:null,status:'unavailable'},{score:61,status:'ok'}]);
  const data=(await h.post('analyze',{...body,night:true})).data;
  assert.equal(data.routes[0].recommended,false);assert.equal(data.routes[0].model,null);
  assert.equal(data.recommendedIndex,1);assert.equal(data.routes[1].model.riskCost,16*.39);
});
test('safety outage leaves candidates usable but does not claim a safe recommendation',async t=>{
  const h=await harness(t,async()=>{throw new Error('test missing source');});
  const data=(await h.post('analyze',{...body,night:true})).data;
  assert.equal(data.safetyUnavailable,true);assert.equal(data.recommendedIndex,null);
  const picked=await h.post('choice',{participantId:body.participantId,planId:data.planId,routeKey:data.routes[0].key});
  assert.equal(picked.status,200);
});
test('combined mode never sends users beyond five extra minutes or five safety points',()=>{
  const routes=validatePlan({...body,routes:[route(25.048,10),route(25.052,20)]});
  routes[0].safety={score:40}; routes[1].safety={score:90};
  const plan={routes,night:true,distribution:true,journey:'x'};
  assert.equal(evaluateNavigation(plan,{},'a').recommendedIndex,null);
  plan.distribution=false;
  assert.equal(evaluateNavigation(plan,{},'a').recommendedIndex,1);
});
test('no scoring runs when night mode is off, and distribution off refuses writes',async t=>{
  let calls=0;const h=await harness(t,async()=>{calls++;return [];});
  const data=(await h.post('analyze',{...body,distribution:false})).data;
  assert.equal(calls,0);
  assert.equal((await h.post('choice',{participantId:body.participantId,planId:data.planId,routeKey:data.routes[0].key})).status,400);
});
test('invalid inputs, other-device plans, unknown routes and expired plans are rejected',async t=>{
  const h=await harness(t);
  assert.equal((await h.post('analyze',{...body,routes:[{...route(),expectedMin:null}]})).status,400);
  assert.equal((await h.post('analyze',{...body,routes:[route(),route()]})).status,400);
  assert.equal((await h.post('analyze',{...body,participantId:'bad'})).status,400);
  const data=(await h.post('analyze',body)).data;
  assert.equal((await h.post('status',{participantId:'different-device-000000',planId:data.planId})).status,403);
  assert.equal((await h.post('choice',{participantId:body.participantId,planId:data.planId,routeKey:'unknown'})).status,400);
  h.advance(30*60*1000);
  assert.equal((await h.post('status',{participantId:body.participantId,planId:data.planId})).status,410);
});

test('simulation reuses live recommendations but keeps virtual counts and history isolated',async t=>{
  const h=await harness(t),plan=(await h.post('analyze',body)).data;
  const input={participantId:body.participantId,planId:plan.planId};
  const first=(await h.post('simulation',{...input,action:'snapshot'})).data;
  const chosen=first.routes.find(r=>r.recommended);
  const one=(await h.post('simulation',{...input,action:'add',count:1})).data;
  assert.equal(one.active,1);assert.equal(one.users[0].routeKey,chosen.key);
  assert.equal(one.events[0].cost,chosen.model.total);
  const many=(await h.post('simulation',{...input,action:'add',count:50,routeKey:plan.routes[0].key})).data;
  assert.equal(many.active,51);assert.ok(many.routes[0].model.loadCost>first.routes[0].model.loadCost);
  assert.ok(many.routes[0].model.probability<first.routes[0].model.probability);
  const real=(await h.post('status',input)).data;
  assert.deepEqual(real.routes.map(r=>r.count),[0,0]);
  assert.equal((await h.post('history',{participantId:body.participantId})).data.events.length,0);
  assert.ok(many.events[0].reasons.some(r=>r.includes('虛擬使用者')));
  const reset=(await h.post('simulation',{...input,action:'reset'})).data;
  assert.equal(reset.active,0);assert.equal(reset.events.length,0);
});

test('simulation transfers a user once, preserves expiry and releases at the virtual deadline',async t=>{
  const h=await harness(t),plan=(await h.post('analyze',body)).data;
  const input={participantId:body.participantId,planId:plan.planId};
  const a=(await h.post('simulation',{...input,action:'add',count:1,routeKey:plan.routes[0].key})).data;
  await h.post('simulation',{...input,action:'advance',minutes:5});
  const moved=(await h.post('simulation',{...input,action:'switch',userId:a.users[0].userId,routeKey:plan.routes[1].key})).data;
  assert.deepEqual(moved.routes.map(r=>r.count),[0,1]);assert.equal(moved.users[0].expiresAt,10);
  const replay=(await h.post('simulation',{...input,action:'switch',userId:a.users[0].userId,routeKey:plan.routes[1].key})).data;
  assert.equal(replay.events.length,moved.events.length);assert.equal(replay.active,1);
  const expired=(await h.post('simulation',{...input,action:'advance',minutes:5})).data;
  assert.equal(expired.active,0);assert.equal(expired.expired,1);
  assert.equal((await h.post('simulation',{...input,action:'switch',userId:a.users[0].userId,routeKey:plan.routes[0].key})).status,400);
  assert.equal((await h.post('simulation',{...input,action:'add',count:101})).status,400);
  assert.equal((await h.post('simulation',{...input,action:'advance',minutes:-1})).status,400);
  assert.equal((await h.post('simulation',{...input,participantId:'another-device-000001'})).status,403);
});

test('simulation respects missing safety and detour constraints; manual choice stays possible',async t=>{
  const h=await harness(t,async()=>[{status:'ok',score:40},{status:'ok',score:90}]);
  const plan=(await h.post('analyze',{...body,night:true,routes:[route(25.048,10),route(25.052,20)]})).data;
  const input={participantId:body.participantId,planId:plan.planId};
  assert.equal((await h.post('simulation',{...input,action:'add',count:10})).status,400);
  const manual=(await h.post('simulation',{...input,action:'add',count:10,routeKey:plan.routes[0].key})).data;
  assert.equal(manual.active,10);assert.equal(manual.recommendedIndex,null);
  const off=(await h.post('analyze',{...body,distribution:false})).data;
  assert.equal((await h.post('simulation',{...input,planId:off.planId})).status,400);
});

test('map point payloads are capped without affecting score counts; only owner/night can fetch them',async t=>{
  const points=Array.from({length:6},(_,i)=>({latitude:25+i/100,longitude:121,name:`store-${i}`,address:'地址',distanceMeters:i}));
  const collection=mapPointCollection(points,'stores',3);
  assert.equal(collection.total,6);assert.equal(collection.shown,3);assert.equal(collection.truncated,true);
  assert.deepEqual(collection.features[0].geometry.coordinates,[121,25]);
  assert.equal(collection.features[1].properties.name,'store-2');
  assert.deepEqual(mapPointCollection([],'streetlights').features,[]);
  const h=await harness(t,async routes=>routes.map(()=>Object.defineProperty({score:80,status:'ok'},'mapPoints',{value:{stores:collection,streetlights:mapPointCollection([],'streetlights')}})));
  const plan=(await h.post('analyze',{...body,night:true})).data;
  assert.equal(plan.routes[0].safety.mapPoints,undefined);
  const input={participantId:body.participantId,planId:plan.planId,routeKey:plan.routes[0].key};
  assert.equal((await h.post('map-points',input)).data.stores.total,6);
  assert.equal((await h.post('map-points',{...input,participantId:'another-device-000001'})).status,403);
  assert.equal((await h.post('map-points',{...input,routeKey:'unknown'})).status,400);
  const off=(await h.post('analyze',body)).data;
  assert.equal((await h.post('map-points',{...input,planId:off.planId})).status,400);
});
