// Account security for the messaging workspace: the second factor (TOTP), the devices signed in to this account and
// how sign-in through the campus SSO provider relates to it. Every API call goes through request() in session.js, so
// the short-lived access token and the silent refresh behave exactly as they do everywhere else in the app.
import React,{useEffect,useState} from 'react';
import { ShieldCheck, KeyRound, Smartphone, Copy, Check, RefreshCw, LogOut, AlertCircle, Users, Link2 } from 'lucide-react';
import { request } from './session.js';

const codeInputProps = recovery => ({
  autoComplete: 'one-time-code',
  inputMode: recovery ? 'text' : 'numeric',
  maxLength: recovery ? 11 : 6,
  placeholder: recovery ? 'ABCDE-FGHIJ' : '123456'
});

/** Step two of sign-in: the API accepts the password (or campus SSO) and waits here for the code. */
export function MfaChallenge({challenge,onVerified,onCancel}){
  const [code,setCode]=useState(''),[recovery,setRecovery]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e){
    e.preventDefault();setError('');setBusy(true);
    try{onVerified(await request('/auth/mfa/verify',null,{method:'POST',body:JSON.stringify({mfaToken:challenge.mfaToken,code,recovery})}));}
    catch(err){setError(err.message);setCode('')}
    finally{setBusy(false)}
  }
  return <div className="crash-screen"><div className="crash-card mfa-card">
    <div className="mfa-badge"><KeyRound size={22}/></div>
    <h1>Two-step verification</h1>
    <p className="mfa-lede">{recovery?'Enter one of the recovery codes you saved when you turned on two-factor authentication.':'Enter the 6-digit code from your authenticator app to finish signing in.'}</p>
    <form className="mfa-form" onSubmit={submit}>
      <input className="code-input" autoFocus {...codeInputProps(recovery)} value={code} onChange={e=>setCode(e.target.value)} aria-label={recovery?'Recovery code':'Verification code'}/>
      {error&&<div className="form-error">{error}</div>}
      <button className="primary-btn" disabled={busy||!code.trim()}>{busy?'Verifying…':'Verify and continue'}</button>
    </form>
    <div className="mfa-links">
      <button type="button" onClick={()=>{setRecovery(!recovery);setCode('');setError('')}}>{recovery?'Use an authenticator code':'Use a recovery code'}</button>
      <button type="button" onClick={onCancel}>Back to sign in</button>
    </div>
  </div></div>;
}

/** Enrolment: mint a secret, confirm one code from the authenticator app, then show the recovery codes once. */
export function MfaEnrollment({token,request,notify,onDone,onSignOut}){
  const [setup,setSetup]=useState(null),[stage,setStage]=useState('loading'),[code,setCode]=useState(''),[codes,setCodes]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  async function start(){
    setStage('loading');setError('');
    try{setSetup(await request('/auth/mfa/setup',token,{method:'POST'}));setStage('scan')}
    catch(e){setError(e.message);setStage('failed')}
  }
  useEffect(()=>{start()},[token]);
  async function confirm(e){
    e.preventDefault();setError('');setBusy(true);
    try{const d=await request('/auth/mfa/enable',token,{method:'POST',body:JSON.stringify({code})});setCodes(d.recoveryCodes);setStage('codes');notify?.('Two-factor authentication is on')}
    catch(err){setError(err.message);setCode('')}
    finally{setBusy(false)}
  }
  async function copyCodes(){
    try{await navigator.clipboard.writeText(codes.join('\n'));setCopied(true)}catch{setCopied(false)}
  }
  if(stage==='loading')return <div className="mfa-loading"><RefreshCw size={16} className="spin"/> Preparing a new secret…</div>;
  if(stage==='failed')return <div className="mfa-loading"><AlertCircle size={16}/> {error} <button className="link-btn" onClick={start}>Try again</button></div>;
  if(stage==='codes')return <div className="mfa-enrol">
    <h3>Save your recovery codes</h3>
    <p className="mfa-lede">Each code works once, and they are the only way in if you lose your authenticator device. Store them somewhere safe — they are shown only this once.</p>
    <div className="recovery-grid">{codes.map(value=><code key={value}>{value}</code>)}</div>
    <div className="mfa-actions">
      <button className="secondary-btn" type="button" onClick={copyCodes}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Copied':'Copy all codes'}</button>
      <button className="primary-btn" type="button" onClick={onDone}>I have saved my codes</button>
      {onSignOut&&<button className="link-btn" type="button" onClick={onSignOut}>Sign out</button>}
    </div>
  </div>;
  return <div className="mfa-enrol">
    <div className="mfa-scan">
      {setup?.qr?<img className="mfa-qr" src={setup.qr} alt="QR code for the authenticator app" width="200" height="200"/>:<div className="mfa-qr-fallback"><Smartphone size={28}/><span>Scanning unavailable — enter the key below by hand.</span></div>}
      <div className="mfa-scan-copy">
        <h3>Scan this with your authenticator app</h3>
        <p className="mfa-lede">Google Authenticator, Microsoft Authenticator, 1Password and similar apps all work. Then enter the 6-digit code it shows to switch the second factor on.</p>
        <p className="mfa-key-label">Can’t scan? Enter this key instead</p>
        <code className="mfa-secret">{setup?.secret||''}</code>
      </div>
    </div>
    <form className="mfa-form" onSubmit={confirm}>
      <input className="code-input" {...codeInputProps(false)} value={code} onChange={e=>setCode(e.target.value)} aria-label="Verification code"/>
      {error&&<div className="form-error">{error}</div>}
      <button className="primary-btn" disabled={busy||!code.trim()}>{busy?'Checking…':'Turn on two-factor authentication'}</button>
    </form>
    {onSignOut&&<div className="mfa-actions"><button className="link-btn" type="button" onClick={onSignOut}>Sign out</button></div>}
  </div>;
}

/** Shown instead of the workspace when a privileged role has no second factor yet: the API is closed until it does. */
export function MfaGate({me,token,request,notify,onEnrolled,onSignOut}){
  return <div className="gate-shell"><div className="gate-card">
    <div className="mfa-badge"><ShieldCheck size={22}/></div>
    <div className="eyebrow">ACCOUNT SECURITY</div>
    <h1>Two-factor authentication is required</h1>
    <p className="mfa-lede">{`Your role (${me.role}) is a privileged one, so the workspace stays closed until a second factor is enrolled on this account. It takes about a minute.`}</p>
    <MfaEnrollment token={token} request={request} notify={notify} onDone={onEnrolled} onSignOut={onSignOut}/>
  </div></div>;
}

/** The Security page: second factor, signed-in devices, and how the campus SSO provider relates to this account. */
export function SecurityView({me,token,request,notify,onProfileChange,onSignOut}){
  const [sessions,setSessions]=useState([]),[loading,setLoading]=useState(true),[enrolling,setEnrolling]=useState(false),[disabling,setDisabling]=useState(false),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function loadSessions(){
    setLoading(true);
    try{setSessions(await request('/auth/sessions',token))}
    catch(e){notify(e.message,'error')}
    finally{setLoading(false)}
  }
  useEffect(()=>{loadSessions()},[token]);
  async function disableFactor(e){
    e.preventDefault();setError('');setBusy(true);
    try{
      const d=await request('/auth/mfa/disable',token,{method:'POST',body:JSON.stringify({code})});
      setDisabling(false);setCode('');
      notify('Two-factor authentication is off. Every other session was signed out.');
      onProfileChange?.(d);
    }catch(err){setError(err.message)}
    finally{setBusy(false)}
  }
  async function signOutDevice(session){
    if(session.current)return onSignOut();
    try{notify((await request(`/auth/sessions/${session.id}`,token,{method:'DELETE'})).message);await loadSessions()}
    catch(e){notify(e.message,'error')}
  }
  const enabled=!!me.mfaEnabled,required=!!me.mfaRequired;
  const status=enabled?<span className="security-pill on"><Check size={13}/> On</span>:required?<span className="security-pill required"><AlertCircle size={13}/> Required — not set up</span>:<span className="security-pill off">Off</span>;
  return <section className="page-section security-page">
    <div className="page-title-row"><div><div className="eyebrow">ACCOUNT · SECURITY</div><h1>Security</h1><p>Your second factor, the devices signed in to this account, and how campus sign-in works.</p></div><div className="permission-status"><ShieldCheck size={17}/> {me.email}</div></div>

    <div className="security-card">
      <div className="security-card-head">
        <span className="security-heading-icon"><KeyRound size={18}/></span>
        <div><h2>Two-factor authentication</h2><p>An authenticator app code is required after your password — or after campus single sign-on.</p></div>
        {status}
      </div>
      {enabled&&<p className="security-note">Your second factor is active. The recovery codes you saved at enrolment are the only way in if you lose your device{required?' — ask a Technical Admin for a reset instead of turning it off':''}.</p>}
      {!enabled&&!required&&!enrolling&&<div className="security-actions"><button className="primary-btn" onClick={()=>setEnrolling(true)}><ShieldCheck size={15}/> Set up two-factor authentication</button><span className="security-hint">Recommended: it protects your account even if your password is exposed.</span></div>}
      {!enabled&&required&&<div className="security-required"><AlertCircle size={16}/><span><b>Required for your role.</b> {me.role} accounts must carry a second factor before the workspace opens. If you lost your device, a Technical Admin can reset it for you.</span></div>}
      {enrolling&&!enabled&&<MfaEnrollment token={token} request={request} notify={notify} onDone={async()=>{setEnrolling(false);await onProfileChange?.()}}/>}
      {enabled&&!required&&(disabling?<form className="mfa-form" onSubmit={disableFactor}>
        <p className="mfa-lede">Enter a code (or a recovery code) to turn the second factor off. Every other session will be signed out.</p>
        <input className="code-input" autoFocus {...codeInputProps(false)} value={code} onChange={e=>setCode(e.target.value)} aria-label="Verification code"/>
        {error&&<div className="form-error">{error}</div>}
        <div className="mfa-actions"><button className="primary-btn" disabled={busy||!code.trim()}>{busy?'Turning off…':'Turn off two-factor authentication'}</button><button className="link-btn" type="button" onClick={()=>{setDisabling(false);setCode('');setError('')}}>Cancel</button></div>
      </form>:<div className="security-actions"><button className="secondary-btn" onClick={()=>setDisabling(true)}>Turn off two-factor authentication</button></div>)}
    </div>

    <div className="security-card">
      <div className="security-card-head">
        <span className="security-heading-icon"><Smartphone size={18}/></span>
        <div><h2>Devices signed in</h2><p>Each sign-in is a session that can be ended on its own. Passwords, roles or second-factor changes end them all.</p></div>
        <button className="secondary-btn" onClick={loadSessions} disabled={loading}><RefreshCw size={15}/> Refresh</button>
      </div>
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th>Session</th><th>Sign out</th></tr></thead>
          <tbody>{sessions.map(session=><tr key={session.id}>
            <td><b>{session.userAgent.slice(0,60)}</b></td>
            <td>{new Date(session.startedAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</td>
            <td>{new Date(session.lastUsedAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</td>
            <td>{session.current?<span className="security-pill on">This device</span>:<span className="security-pill">Active</span>}</td>
            <td><button className="table-save-btn" title="Sign this device out" onClick={()=>signOutDevice(session)}><LogOut size={15}/></button></td>
          </tr>)}</tbody>
        </table>
        {!loading&&sessions.length===0&&<div className="admin-empty">No devices are signed in.</div>}
        {loading&&<div className="admin-empty">Loading your sessions…</div>}
      </div>
    </div>

    <div className="security-card">
      <div className="security-card-head">
        <span className="security-heading-icon"><Link2 size={18}/></span>
        <div><h2>Sign-in methods</h2><p>Ways this account can be opened.</p></div>
      </div>
      <div className="security-methods">
        <div className="security-method"><span className="security-method-icon"><KeyRound size={16}/></span><div><b>University password</b><small>{me.email} · {me.mfaEnabled?'followed by your authenticator code':'one step sign-in'}</small></div><span className="security-pill on">Available</span></div>
        <div className="security-method"><span className="security-method-icon"><Users size={16}/></span><div><b>Campus single sign-on — Google and Facebook</b><small>Provided by the CUI_Communicate SSO provider and matched to this account by your @comsats.edu.pk email. Your second factor still applies, because providers do not guarantee one.</small></div><span className="security-pill on">Available</span></div>
      </div>
    </div>
  </section>;
}
