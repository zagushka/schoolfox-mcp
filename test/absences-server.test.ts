import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const target = {schoolId:'schoolA',classId:'classA',pupilId:'pupilA'};
const dates = {reason:'ABSENCE_ILLNESS',startDate:'2026-10-25',endDate:'2026-10-25',allDayEvent:true};
const user = {id:'parentA',fullUsername:'Fixture Parent',twoFactorAuthActive:false,twoFactorAuthStatus:'Optional'};
const inventory = [
  {id:'schoolA',itemType:'School',applicationType:'SchoolFox',purchasedFeature:'Plus'},
  {id:'pupilA',itemType:'Pupil',applicationType:'SchoolFox',schoolId:'schoolA',schoolClassId:'classA',isActive:true,deleted:false}
];
const absence = {
  id:'absenceA',schoolId:'schoolA',schoolClassId:'classA',pupilId:'pupilA',messageType:'Absence',
  content:'ABSENCE_OTHER',isOwned:true,createdBy:'parentA',deleted:false,isArchived:false,
  startDate:'2026-10-24T22:00:00.000Z',endDate:'2026-10-25T22:59:59.000Z',allDayEvent:true,
  topic:'Absence',instantMessagesAllowed:true,customField:'keep fixture',
  info:[{id:'recipientA'}],recipientsNames:'Fixture Teacher',
  messageProperties:JSON.stringify({Other:'preserved',Changes:[{Date:'2026-10-01T12:00:00.000Z',Text:'Earlier note'}]})
};
type Call = {url:URL;method:string;body:unknown};
type Handler = (call:Call) => Response | undefined;

async function withSdk(handler:Handler, run:(sdk:Client,calls:Call[])=>Promise<void>) {
  const calls:Call[]=[];
  const fetcher = async (input:string|URL|Request,init:RequestInit={}) => {
    const call={url:new URL(String(input)),method:init.method ?? 'GET',body:init.body ? JSON.parse(String(init.body)) as unknown : undefined};
    calls.push(call);
    assert.equal(call.url.origin,'https://api.schoolfox.com');
    const response=handler(call);
    if (response) return response;
    if (call.url.pathname === '/api/Users/login') return Response.json({token:'fixture-token',user});
    if (call.url.pathname === '/api/Common/Inventory') return Response.json(inventory);
    if (call.url.pathname === '/api/SchoolClasses/classA/Teachers') return Response.json([
      {teacherId:'teacherA',firstName:'First',lastName:'Fixture'},
      {teacherId:'teacherB',firstName:'Second',lastName:'Fixture'}
    ]);
    if (call.url.pathname === '/api/Messages/HasAbsence') return Response.json(false);
    if (call.url.pathname === '/tables/Messages/absenceA') return Response.json(absence);
    if (call.method === 'POST' && call.url.pathname === '/tables/Messages') return Response.json({id:'savedA'});
    if (call.url.pathname === '/api/Messages/savedA/Pupils/pupilA/TeacherRecipients') return Response.json({});
    if (call.method === 'PATCH' && call.url.pathname === '/api/Messages/absenceA') return Response.json({...absence,...call.body as object});
    throw new Error(`Unexpected fixture request: ${call.method} ${call.url.pathname}`);
  };
  const school=new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'fixture@example.invalid',SCHOOLFOX_PASSWORD:'fixture-password'}),fetcher as typeof fetch,()=>new Date('2026-10-16T10:00:00.000Z'));
  const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
  const server=createServer(school);
  const sdk=new Client({name:'absence-sdk-fixture',version:'1.0.0'});
  try {
    await server.connect(serverSide); await sdk.connect(clientSide);
    await run(sdk,calls);
  } finally {await sdk.close();await server.close();}
}
async function call(sdk:Client,name:string,args:Record<string,unknown>) {
  const result=await sdk.callTool({name,arguments:args});
  assert.equal(result.isError,undefined,`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent as Record<string,unknown>;
}
const writes=(calls:Call[])=>calls.filter(x=>x.method !== 'GET' && x.url.pathname !== '/api/Users/login');

test('absence list, detail and options execute through SDK with exact context and paging',async()=>{
  await withSdk(request=>request.url.pathname === '/tables/Messages' ? Response.json({results:[absence,{...absence,id:'normalA',messageType:'Normal'}],count:12}) : undefined,async(sdk,calls)=>{
    const listed=await call(sdk,'schoolfox_absences',{...target,top:7,skip:3});
    const request=calls.find(x=>x.url.pathname === '/tables/Messages')!;
    assert.equal(request.url.searchParams.get('$top'),'7');
    assert.equal(request.url.searchParams.get('$skip'),'3');
    assert.equal(request.url.searchParams.get('$filter'),"Deleted eq false and SchoolClassId eq 'classA' and PupilId eq 'pupilA'");
    assert.deepEqual((listed.results as Array<{id:string}>).map(x=>x.id),['absenceA']);
    assert.equal(listed.sourceMessageCount,12);
    const detail=await call(sdk,'schoolfox_absence_detail',{...target,messageId:'absenceA'});
    assert.equal(detail.id,'absenceA');
    const options=await call(sdk,'schoolfox_absence_options',target);
    assert.deepEqual(options.reasons,['ABSENCE_ILLNESS','ABSENCE_DOCTOR','ABSENCE_PRIVATE_APPOINTMENT','ABSENCE_FAMILY_REASONS','ABSENCE_OTHER']);
    assert.deepEqual((options.teachers as Array<{teacherId:string}>).map(x=>x.teacherId),['teacherA','teacherB']);
    assert.deepEqual(writes(calls),[]);
  });
});

test('absence report SDK handler normalizes DST dates and sends an exact teacher ID array once',async()=>{
  await withSdk(()=>undefined,async(sdk,calls)=>{
    await call(sdk,'schoolfox_report_absence',{...target,...dates,teacherIds:['teacherB']});
    const overlap=calls.find(x=>x.url.pathname === '/api/Messages/HasAbsence')!;
    assert.equal(overlap.url.searchParams.get('pupilId'),'pupilA');
    assert.equal(overlap.url.searchParams.get('startDate'),'2026-10-24T22:00:00.000Z');
    assert.equal(overlap.url.searchParams.get('endDate'),'2026-10-25T22:59:59.000Z');
    assert.equal(overlap.url.searchParams.has('ignoreMessageId'),false);
    const sent=writes(calls);
    assert.equal(sent.length,2);
    assert.equal(sent[0]?.url.pathname,'/tables/Messages');
    assert.deepEqual(sent[0]?.body,{
      messageType:'Absence',topic:'Absence',instantMessagesAllowed:true,content:'ABSENCE_ILLNESS',
      allDayEvent:true,startDate:'2026-10-24T22:00:00.000Z',endDate:'2026-10-25T22:59:59.000Z',
      schoolId:'schoolA',schoolClassId:'classA',applicationVersion:'10.10.0',recipientsType:'NotAll'
    });
    assert.equal(sent[1]?.url.pathname,'/api/Messages/savedA/Pupils/pupilA/TeacherRecipients');
    assert.equal(sent[1]?.url.searchParams.get('sendAbsenceNotifications'),'true');
    assert.deepEqual(sent[1]?.body,['teacherB']);
    assert.ok(calls.indexOf(overlap)<calls.indexOf(sent[0]!));
  });
});

test('partial absence delivery returns the saved message ID through SDK without replay',async()=>{
  await withSdk(request=>request.url.pathname.endsWith('/TeacherRecipients') ? new Response(null,{status:503}) : undefined,async(sdk,calls)=>{
    const result=await call(sdk,'schoolfox_report_absence',{...target,...dates,teacherIds:[]});
    assert.equal(result.messageId,'savedA');
    assert.equal(result.delivery,'incomplete');
    assert.equal(writes(calls).length,2);
    assert.deepEqual(writes(calls)[1]?.body,[]);
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  });
});

test('absence edit SDK handler maps context and dates, checks overlap, and preserves update history',async()=>{
  await withSdk(()=>undefined,async(sdk,calls)=>{
    await call(sdk,'schoolfox_edit_absence',{
      ...target,messageId:'absenceA',reason:'ABSENCE_DOCTOR',startDate:'2026-10-26T09:00:00+01:00',
      endDate:'2026-10-26T10:00:00+01:00',allDayEvent:false,timeZone:'Europe/Berlin',changeNote:'Fixture correction'
    });
    const overlap=calls.find(x=>x.url.pathname === '/api/Messages/HasAbsence')!;
    assert.equal(overlap.url.searchParams.get('ignoreMessageId'),'absenceA');
    assert.equal(overlap.url.searchParams.get('pupilId'),'pupilA');
    assert.equal(overlap.url.searchParams.get('startDate'),'2026-10-26T08:00:00.000Z');
    assert.equal(overlap.url.searchParams.get('endDate'),'2026-10-26T09:00:00.000Z');
    const sent=writes(calls);
    assert.equal(sent.length,1);
    assert.equal(sent[0]?.method,'PATCH');
    assert.equal(sent[0]?.url.pathname,'/api/Messages/absenceA');
    const body=sent[0]?.body as Record<string,unknown>;
    assert.equal(body.schoolId,'schoolA'); assert.equal(body.schoolClassId,'classA'); assert.equal(body.pupilId,'pupilA');
    assert.equal(body.content,'ABSENCE_DOCTOR'); assert.equal(body.allDayEvent,false);
    assert.equal(body.startDate,'2026-10-26T08:00:00.000Z'); assert.equal(body.endDate,'2026-10-26T09:00:00.000Z');
    assert.equal(body.customField,'keep fixture'); assert.equal(body.info,undefined);assert.equal(body.recipientsNames,undefined);
    const properties=JSON.parse(String(body.messageProperties));
    assert.equal(properties.Other,'preserved');
    assert.deepEqual(properties.Changes,[{Date:'2026-10-01T12:00:00.000Z',Text:'Earlier note'},{Date:'2026-10-16T10:00:00.000Z',Text:'Fixture correction'}]);
    assert.ok(calls.indexOf(overlap)<calls.indexOf(sent[0]!));
  });
});

test('invalid absence SDK inputs and foreign target stop before account writes',async()=>{
  await withSdk(()=>undefined,async(sdk,calls)=>{
    for (const args of [
      {...target,...dates},
      {...target,...dates,teacherIds:['teacherA'],reason:'NOT_A_REASON'},
      {...target,...dates,teacherIds:['teacherA'],startDate:'2026-02-30'},
      {...target,...dates,teacherIds:['teacherA'],timeZone:'Not/A_Zone'},
      {...target,...dates,teacherIds:['unknownTeacher']},
      {...target,...dates,pupilId:'foreignPupil',teacherIds:['teacherA']}
    ]) {
      const result=await sdk.callTool({name:'schoolfox_report_absence',arguments:args});
      assert.equal(result.isError,true,JSON.stringify(args));
    }
    const invalidEdit=await sdk.callTool({name:'schoolfox_edit_absence',arguments:{...target,...dates,messageId:'absenceA',startDate:'invalid'}});
    assert.equal(invalidEdit.isError,true);
    assert.deepEqual(writes(calls),[]);
  });
});
