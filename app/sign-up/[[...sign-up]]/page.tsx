'use client';

import { SignUp, useSignIn, useSignUp } from '@clerk/nextjs';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type InvitationStage = 'sign_up' | 'sign_in' | 'complete' | null;

function SignUpContent() {
  const searchParams = useSearchParams();
  const ticket = searchParams.get('__clerk_ticket');
  const status = searchParams.get('__clerk_status') as InvitationStage;
  const finishInvitation = searchParams.get('invite') === 'accept';

  return (
    <main className="auth-shell">
      <div className="auth-brand"><span className="brand-mark">S</span><span>StockSense</span></div>
      <p className="auth-kicker">YOUR OPERATIONS START HERE</p>
      {finishInvitation
        ? <AcceptExistingInvitation />
        : ticket
          ? <AcceptInvitation ticket={ticket} status={status} />
          : <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />}
    </main>
  );
}

function AcceptInvitation({ ticket, status }: { ticket: string; status: InvitationStage }) {
  const router = useRouter();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const signInStarted = useRef(false);
  const [existingAccount, setExistingAccount] = useState(status === 'sign_in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signInWithInviteTicket = useCallback(async () => {
    if (!signInLoaded || signInStarted.current) return;
    signInStarted.current = true;
    setBusy(true);
    setError('');
    try {
      const attempt = await signIn.create({ strategy: 'ticket', ticket });
      if (attempt.status !== 'complete' || !attempt.createdSessionId) {
        throw new Error('Sign in with this invitation could not be completed. Try signing in with your account email, then open the invitation again.');
      }
      await setSignInActive({ session: attempt.createdSessionId, redirectUrl: '/sign-up?invite=accept' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in with this invitation.');
      setBusy(false);
      signInStarted.current = false;
    }
  }, [signInLoaded, signIn, ticket, setSignInActive]);

  useEffect(() => {
    if (signInLoaded && existingAccount && status !== 'complete' && !signInStarted.current) {
      void signInWithInviteTicket();
    }
  }, [signInLoaded, existingAccount, status, signInWithInviteTicket]);

  const acceptNewAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signUpLoaded || busy) return;
    const form = new FormData(event.currentTarget);
    const firstName = String(form.get('firstName') || '').trim();
    const lastName = String(form.get('lastName') || '').trim();
    const password = String(form.get('password') || '');

    setBusy(true);
    setError('');
    try {
      const result = await signUp.create({ strategy: 'ticket', ticket, firstName, lastName, password });
      if (result.status !== 'complete' || !result.createdSessionId) {
        throw new Error('The invitation needs more information or may have expired. Contact your workspace admin for a new invitation.');
      }
      await setSignUpActive({ session: result.createdSessionId, redirectUrl: '/sign-up?invite=accept' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not accept this invitation. Ask your workspace admin to resend it.';
      setError(message);
      if (/already exists|already in use|email address.*taken|identifier.*taken/i.test(message)) {
        setExistingAccount(true);
      }
      setBusy(false);
    }
  };

  if (status === 'complete') return <AcceptExistingInvitation />;
  if (existingAccount) {
    return (
      <section className="invite-accept-card">
        <div className="invite-heading">
          <span className="invite-symbol" aria-hidden="true">↗</span>
          <h1>Accept your team invitation</h1>
          <p>Sign in to your existing account, then we’ll add it to this invited workspace.</p>
        </div>
        {busy && !error && <p className="invite-pending" role="status">Verifying your invitation…</p>}
        {error && <p className="invite-error" role="alert">{error}</p>}
        <button className="invite-submit" type="button" disabled={!signInLoaded || busy} onClick={() => { signInStarted.current = false; void signInWithInviteTicket(); }}>
          {busy ? 'Signing in…' : 'Sign in with invitation'}
        </button>
        <p className="invite-signin">
          Need to use a different account?{' '}
          <button type="button" onClick={() => router.push(`/sign-in?redirect_url=${encodeURIComponent(`/sign-up?__clerk_ticket=${encodeURIComponent(ticket)}&__clerk_status=sign_in`)}`)}>
            Sign in with email
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="invite-accept-card" aria-labelledby="invite-title">
      <div className="invite-heading">
        <span className="invite-symbol" aria-hidden="true">↗</span>
        <h1 id="invite-title">Accept your team invitation</h1>
        <p>Create your account to join the StockSense workspace. Your invited role will be applied automatically.</p>
      </div>
      <form className="invite-form" onSubmit={acceptNewAccount}>
        <label className="invite-field"><span>First name</span><input name="firstName" type="text" autoComplete="given-name" maxLength={100} /></label>
        <label className="invite-field"><span>Last name</span><input name="lastName" type="text" autoComplete="family-name" maxLength={100} /></label>
        <label className="invite-field"><span>Create password</span><input name="password" type="password" autoComplete="new-password" required minLength={8} /></label>
        <div id="clerk-captcha" />
        {error && <p className="invite-error" role="alert">{error}</p>}
        <button className="invite-submit" type="submit" disabled={!signUpLoaded || busy}>
          {busy ? 'Accepting invitation…' : 'Accept invitation'}
        </button>
      </form>
      <p className="invite-signin">
        Already have a StockSense account?{' '}
        <button type="button" onClick={() => setExistingAccount(true)}>Continue existing account</button>
      </p>
    </section>
  );
}

function AcceptExistingInvitation() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/invitations/accept', { method: 'POST' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not accept this invitation.');
      router.replace('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not accept this invitation.');
      setBusy(false);
    }
  }, [router]);

  useEffect(() => { void accept(); }, [accept]);
  return (
    <section className="invite-accept-card">
      <div className="invite-heading">
        <h1>{busy ? 'Accepting invitation…' : 'Invitation accepted'}</h1>
        <p>{busy ? 'Adding your signed-in account to the invited StockSense workspace.' : 'Continue to your workspace.'}</p>
      </div>
      {error
        ? <><p className="invite-error" role="alert">{error}</p><button type="button" className="invite-submit" onClick={() => void accept()}>Try again</button></>
        : !busy && <button className="invite-submit" type="button" onClick={() => router.push('/dashboard')}>Open StockSense</button>}
    </section>
  );
}

export default function SignUpPage() {
  return <Suspense fallback={<main className="auth-shell"><p>Loading invitation…</p></main>}><SignUpContent /></Suspense>;
}
