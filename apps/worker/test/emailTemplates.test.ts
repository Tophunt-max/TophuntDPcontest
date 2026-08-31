/**
 * Email templates.
 *
 * Pure functions, so these are cheap and worth having: they lock the contract
 * every send site relies on (a subject, an HTML part AND a plain-text part), the
 * one-time code actually appearing, HTML-escaping of user-supplied names so a
 * display name can never inject markup, and the shared footer/support line.
 */
import { describe, it, expect } from 'vitest';
import {
  verificationCodeEmail,
  securityCodeEmail,
  identifierChangedEmail,
  welcomeEmail,
  accountDeletionScheduledEmail,
  testEmail,
  coinsAddedEmail,
  coinsReversedEmail,
  withdrawalDecisionEmail,
  contestWinEmail,
  contestRefundEmail,
  passwordChangedEmail,
} from '../src/lib/emailTemplates';

const all = [
  ['verification', verificationCodeEmail('123456')],
  ['security', securityCodeEmail('654321')],
  ['identifier-changed', identifierChangedEmail('email', 'ne***@example.com')],
  ['welcome', welcomeEmail('Alice')],
  ['deletion', accountDeletionScheduledEmail('30 September 2026')],
  ['test', testEmail()],
  ['coins-added', coinsAddedEmail(500)],
  ['coins-reversed', coinsReversedEmail(500, 'refunded')],
  ['withdrawal-approved', withdrawalDecisionEmail('approved', 1000)],
  ['withdrawal-paid', withdrawalDecisionEmail('paid', 1000)],
  ['withdrawal-rejected', withdrawalDecisionEmail('rejected', 1000, 'invalid UPI id')],
  ['contest-win', contestWinEmail('Sunset vs Sunrise', 200)],
  ['contest-refund', contestRefundEmail('Sunset vs Sunrise', 'it ended in a tie')],
  ['password-changed', passwordChangedEmail()],
] as const;

describe('every template', () => {
  it('returns a subject, an html part and a plain-text part', () => {
    for (const [name, t] of all) {
      expect(t.subject, `${name} subject`).toBeTruthy();
      expect(t.html, `${name} html`).toContain('<!doctype html>');
      expect(t.text.length, `${name} text`).toBeGreaterThan(20);
    }
  });

  it('carries the brand and a support contact in both parts', () => {
    for (const [name, t] of all) {
      expect(t.html, `${name} brand html`).toContain('TopHunt');
      expect(t.html, `${name} support html`).toContain('support@tophunt.in');
      expect(t.text, `${name} support text`).toContain('support@tophunt.in');
    }
  });
});

describe('one-time-code templates', () => {
  it('render the exact code in both the html and the text', () => {
    const v = verificationCodeEmail('123456');
    expect(v.html).toContain('123456');
    expect(v.text).toContain('123456');
    expect(v.subject).toContain('123456');

    const s = securityCodeEmail('654321');
    expect(s.html).toContain('654321');
    expect(s.text).toContain('654321');
  });

  it('the security code warns not to share it', () => {
    const s = securityCodeEmail('111111');
    expect(s.html.toLowerCase()).toMatch(/do not share|don't share/);
    expect(s.text.toLowerCase()).toMatch(/do not share|don't share/);
  });
});

describe('security alert', () => {
  it('names the masked new value and tells the owner what to do if it wasn\'t them', () => {
    const e = identifierChangedEmail('phone', '+9198****10');
    expect(e.subject).toMatch(/phone number/i);
    expect(e.html).toContain('+9198****10');
    expect(e.html.toLowerCase()).toContain('contact support');
  });
});

describe('escaping', () => {
  /**
   * A display name is user-supplied and flows into the welcome email. It must be
   * HTML-escaped, or a name like `<img onerror=…>` would render as markup in the
   * inbox.
   */
  it('escapes a hostile display name', () => {
    const e = welcomeEmail('<script>alert(1)</script>');
    expect(e.html).not.toContain('<script>alert(1)</script>');
    expect(e.html).toContain('&lt;script&gt;');
  });
});

describe('deletion scheduled', () => {
  it('states the cancel-by date', () => {
    const e = accountDeletionScheduledEmail('30 September 2026');
    expect(e.html).toContain('30 September 2026');
    expect(e.text).toContain('30 September 2026');
    expect(e.html.toLowerCase()).toContain('sign in');
  });
});

describe('financial receipts', () => {
  it('coins-added names the amount in both parts', () => {
    const e = coinsAddedEmail(500);
    expect(e.subject).toContain('500');
    expect(e.html).toContain('500');
    expect(e.text).toContain('500');
  });

  it('coins-reversed names the amount and the reason', () => {
    const e = coinsReversedEmail(750, 'charged back');
    expect(e.html).toContain('750');
    expect(e.html.toLowerCase()).toContain('charged back');
    expect(e.text).toContain('750');
  });

  it('withdrawal-paid reads as sent, rejected reads as returned + reason', () => {
    const paid = withdrawalDecisionEmail('paid', 1000);
    expect(paid.subject.toLowerCase()).toContain('sent');
    expect(paid.html).toContain('1000');

    const rejected = withdrawalDecisionEmail('rejected', 1000, 'invalid UPI id');
    expect(rejected.subject.toLowerCase()).toContain('reject');
    expect(rejected.html.toLowerCase()).toContain('returned to your wallet');
    expect(rejected.html).toContain('invalid UPI id');
  });

  it('contest-win names the battle and the prize', () => {
    const e = contestWinEmail('Sunset vs Sunrise', 200);
    expect(e.html).toContain('Sunset vs Sunrise');
    expect(e.html).toContain('200');
    expect(e.subject).toContain('200');
  });

  it('contest-refund names the battle and says the fee came back', () => {
    const e = contestRefundEmail('Sunset vs Sunrise', 'it ended in a tie');
    expect(e.html).toContain('Sunset vs Sunrise');
    expect(e.html.toLowerCase()).toContain('refunded');
    expect(e.text.toLowerCase()).toContain('tie');
  });

  it('tolerates a null battle title and null/undefined coins without crashing', () => {
    const win = contestWinEmail(null, undefined);
    expect(win.html).toContain('your battle');
    expect(win.html).toContain('0');
    const added = coinsAddedEmail(undefined);
    expect(added.subject).toContain('0');
  });
});

describe('password-changed security alert', () => {
  it('tells the owner what to do if it was not them', () => {
    const e = passwordChangedEmail();
    expect(e.subject.toLowerCase()).toContain('password');
    expect(e.html.toLowerCase()).toMatch(/did not|didn't/);
    expect(e.html.toLowerCase()).toContain('reset your password');
    expect(e.text.toLowerCase()).toContain('contact support');
  });

  /** A win/refund escapes a hostile battle title (titles are user-supplied). */
  it('escapes a hostile battle title', () => {
    const e = contestWinEmail('<img onerror=x>', 10);
    expect(e.html).not.toContain('<img onerror=x>');
    expect(e.html).toContain('&lt;img');
  });
});
