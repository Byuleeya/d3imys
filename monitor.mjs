import fs from 'node:fs';
import path from 'node:path';
import { addDays, prettyDate, pickDate } from './parser.mjs';
import { querySchedule } from './sources.mjs';

const env=(k,d='')=>String(process.env[k]??d).trim();
const nenv=(k,d,min)=>Math.max(min,Number(env(k,String(d)))||d);
const CFG={
  token:env('TELEGRAM_BOT_TOKEN'),chatId:env('TELEGRAM_CHAT_ID'),
  theaterCode:env('THEATER_CODE','0013'), movieNo:env('MOVIE_NO','30001790'),
  start:env('START_DATE','20261221'),end:env('END_DATE','20270110'),
  knownOpenDate:env('KNOWN_OPEN_DATE','20261220'),
  relayUrl:env('RELAY_URL','https://mcp.aka.page/api/cgv/timetable'),
  directUrl:env('DIRECT_URL','https://cgv.co.kr/api/v1/booking/searchMovScnInfo'),
  pollMin:nenv('POLL_MIN_SECONDS',5,5),pollMax:nenv('POLL_MAX_SECONDS',7,5),
  timeoutMs:nenv('REQUEST_TIMEOUT_MS',8000,2500),
  cacheBust:env('CACHE_BUST','true').toLowerCase()!=='false',
  errorCooldownMs:nenv('ERROR_ALERT_COOLDOWN_SECONDS',900,60)*1000,
  baselineRecheckMs:nenv('BASELINE_RECHECK_MINUTES',10,3)*60000,
  imaxCapacity:nenv('IMAX_CAPACITY',624,1),
  stateFile:env('STATE_FILE','/data/dune3-imax-state.json'),
};
if(!/^\d{8}$/.test(CFG.start)||!/^\d{8}$/.test(CFG.end)||CFG.end<CFG.start) throw new Error('START_DATE/END_DATE는 YYYYMMDD 순서로 설정');
if (!CFG.token || !CFG.chatId) throw new Error('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 설정 필요');
const BASE_LINK='https://cgv.co.kr/cnm/movieBook/movie';
let stopping=false, failed=0, lastErrorAlert=0, lastError='', startupSent=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log(`[${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})} KST]`,...a);
function kstDate() {const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));return v.year+v.month+v.day;}
const jitter=()=>1000*(Math.min(CFG.pollMin,CFG.pollMax)+Math.random()*Math.abs(CFG.pollMax-CFG.pollMin));
function newState(){return {version:1,cursor:CFG.start,openedDates:{},seen:{},baselineVerified:false};}
function loadState() {try{const s=JSON.parse(fs.readFileSync(CFG.stateFile,'utf8'));return {...newState(),...s};}catch{return newState();}}
let state=loadState();
function saveState(){const file=CFG.stateFile;fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,file);}
async function tg(text,{silent=false}={}){
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),12000);
  try{
    const r=await fetch(`https://api.telegram.org/bot${CFG.token}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,
      body:JSON.stringify({chat_id:CFG.chatId,text,disable_notification:silent,disable_web_page_preview:true})
    });
    if(!r.ok){const x=await r.text();throw new Error(`Telegram HTTP ${r.status}: ${x.slice(0,180)}`);}
  }finally{clearTimeout(t);}
}
async function errorAlert(message){
  const now=Date.now();log('ERROR:',message.slice(0,600));
  // Never flood Telegram on repeatedly failing polling cycles.
  if(lastErrorAlert && now-lastErrorAlert<CFG.errorCooldownMs) return;
  lastError=message;lastErrorAlert=now;
  try{await tg(`⚠️ [듄3 용산 IMAX 오픈 감시] 조회 실패\n${message.slice(0,750)}\n\n정상 조회가 복구될 때까지 예매 오픈을 확인할 수 없습니다.`);}catch(e){log('텔레그램 오류 알림 실패:',e.message);}
}
function bookingLink(date){return `${BASE_LINK}?${new URLSearchParams({movNo:CFG.movieNo,siteNo:CFG.theaterCode,scnYmd:date})}`;}
function formatShow(s){let result=`• ${s.time}${s.end?`~${s.end}`:''} / ${s.hall}`;if(s.remaining!=null)result+=` / 잔여 ${s.remaining}${s.total!=null?`/${s.total}`:''}석`;return result;}
async function handleShows(date,shows,source) {
  const known=new Set(state.seen[date]||[]);
  const fresh=shows.filter(x=>!known.has(x.key));
  if(fresh.length) {
    const summary=fresh.slice(0,12).map(formatShow).join('\n');
    const msg=`🚨 [CGV 용산 IMAX 예매 오픈!]\n\n🎬 듄: 파트 3\n📅 ${prettyDate(date)}\n📍 용산아이파크몰 IMAX\n🆕 새로 확인된 회차 ${fresh.length}건\n\n${summary}${fresh.length>12?'\n(나머지 회차 생략)':''}\n\n지금 CGV에서 좌석을 확인하세요:\n${bookingLink(date)}`;
    await tg(msg);
    log(`OPEN ${date}: 신규=${fresh.length}, 전체=${shows.length}, source=${source}`);
    state.seen[date]=[...new Set([...known,...shows.map(x=>x.key)])];
  }
  state.openedDates[date]=true;
  if(date===state.cursor) {
    let next=addDays(date,1);
    while(next<=CFG.end && state.openedDates[next]) next=addDays(next,1);
    state.cursor=next;
  }
  saveState();
}
function failureWait(err,n){
 const isBlock=err.http===429||err.http===403||/blocked|access denied|차단|captcha/i.test(err.message);
 const base=isBlock?60000:15000;
 return Math.max(err.retryAfter?err.retryAfter*1000:0,Math.min(isBlock?600000:300000,base*Math.pow(2,Math.min(n-1,4))));
}
function errSourceText(err){return err?.errors?.map(x=>`${x.source}:${x.http||'-'} ${x.message}`).join(' | ')||String(err.message||err);}
function stopHandler(){stopping=true;log('종료 신호 받음. 안전하게 정리 중');}
process.on('SIGTERM',stopHandler);process.on('SIGINT',stopHandler);
async function main(){
 log('CGV 용산 IMAX 듄 파트3 신규 예매 오픈 감시 v1 (조회/텔레그램 전용)');
 log(`기존 2026-12-16~20 제외 / 감시 ${CFG.start}~${CFG.end} / ${CFG.pollMin}~${CFG.pollMax}초 / 영화번호 ${CFG.movieNo}`);
 log(`Primary=relay, fallback=CGV public timetable; 로그인/좌석선점/결제 없음; state=${CFG.stateFile}`);
 let tick=0,baselineLastTry=0;
 while(!stopping){
  if(kstDate()>CFG.end || (state.cursor>CFG.end && tick>0)) {log('감시 종료: 대상 날짜 범위 종료');try{await tg('⏹ [듄3 용산 IMAX] 설정된 감시 날짜 범위가 종료되어 감시를 마칩니다.',{silent:true});}catch{}return;}
  // Prevent treating a broken/empty relay as a normal unopened date. The date
  // 2026-12-20 is reported as already on sale as of Nov 25, 2026.
  const needsBaseline=kstDate()<=CFG.knownOpenDate && (!state.baselineVerified || !state.lastVerifiedAt || Date.now()-Date.parse(state.lastVerifiedAt)>=CFG.baselineRecheckMs);
  if(needsBaseline){
    if(Date.now()-baselineLastTry<CFG.baselineRecheckMs){await sleep(Math.min(30000,CFG.baselineRecheckMs-(Date.now()-baselineLastTry)));continue;}
    baselineLastTry=Date.now();
    try{
      const x=await querySchedule(CFG.knownOpenDate,CFG,undefined,{requireShows:true});
      state.baselineVerified=true;state.lastVerifiedAt=new Date().toISOString();saveState();failed=0;
      log(`기준일 ${CFG.knownOpenDate} 검증 성공: 듄3 IMAX ${x.shows.length}회차 / ${x.source}`);
    }catch(err){state.baselineVerified=false;saveState();failed++;await errorAlert(`기존 예매 오픈 기준일 ${CFG.knownOpenDate} 검증 실패: ${errSourceText(err)}. 감시 시작 보류.`);await sleep(Math.min(CFG.baselineRecheckMs,failureWait(err,failed)));continue;}
  }
  if(!startupSent){
    try{await tg(`✅ [CGV 용산 IMAX - 듄: 파트 3] 감시 시작\n이미 열린 12/16~12/20은 제외\n신규 감시: ${prettyDate(CFG.start)}부터 ${prettyDate(CFG.end)}까지\n간격: 약 ${CFG.pollMin}~${CFG.pollMax}초 (주요 날짜 우선)\n알림: 새로운 IMAX 예매 회차만\n로그인·좌석 선택 없음`,{silent:true});startupSent=true;}catch(err){log('텔레그램 시작 알림 오류:',err.message);await sleep(30000);continue;}
  }
  const date=pickDate(state,CFG.start,CFG.end,tick++,7);
  if(!date){log('모든 대상 날짜의 회차가 이미 열림; 감시 종료');return;}
  try{
    const r=await querySchedule(date,CFG);
    if(failed){log(`시간표 조회 복구: ${date}, 경로=${r.source}`);failed=0;lastError='';}
    if(r.shows.length>0) await handleShows(date,r.shows,r.source);
    else if(tick<=4 || tick%10===0) log(`${date}: 아직 새 IMAX 회차 없음 / source=${r.source} / 전체시간표후보=${r.candidateCount}`);
    if(r.errors?.length && tick%20===0)log('대체경로 사용:',r.errors.map(x=>`${x.source} ${x.message}`).join(' | '));
    await sleep(r.shows.length && date===addDays(state.cursor,-1)?2000:jitter());
  }catch(err){
    failed++;
    await errorAlert(`연속 실패 ${failed}회 / ${date} / ${errSourceText(err)}`);
    await sleep(failureWait(err,failed));
  }
 }
 log('감시 정상 종료');
}
main().catch(async e=>{log('FATAL',e.stack||e);try{await tg('🚨 [듄3 용산 IMAX] 감시봇 치명적 오류\n'+String(e.message||e).slice(0,800));}catch{}process.exitCode=1;});
