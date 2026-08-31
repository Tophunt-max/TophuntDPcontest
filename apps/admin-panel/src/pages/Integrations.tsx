import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, describeError, type IntegrationsResponse, type SecretStatus } from "@/lib/api";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  KeyRound,
  Loader2,
  MessageSquare,
  Mail,
  CreditCard,
  Video,
  HardDrive,
  ShieldCheck,
  Activity,
  Save,
  Send,
  Trash2,
  Info,
} from "lucide-react";

/**
 * Integrations — every third-party service the app talks to, configured here
 * instead of by redeploying the Worker.
 *
 * Credential values are WRITE-ONLY by design: the server returns a masked hint
 * and a fingerprint but never the secret, so this page cannot be used to read
 * keys back out. Each section has a Test button that exercises the real
 * credential server-side, because a settings screen that cannot prove a key works
 * only moves the debugging problem elsewhere.
 */

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";

const GROUP_META: Record<string, { title: string; icon: any; blurb: string }> = {
  sms: { title: "SMS gateway", icon: MessageSquare, blurb: "Delivers login and password-reset codes." },
  email: { title: "Email", icon: Mail, blurb: "Transactional email for verification codes." },
  payments: { title: "Payments", icon: CreditCard, blurb: "Razorpay checkout, webhook and reconciliation." },
  video: { title: "Video (Bunny Stream)", icon: Video, blurb: "Optional. Without it, videos stay on R2." },
  storage: { title: "Storage (R2)", icon: HardDrive, blurb: "S3 keys used to mint presigned uploads." },
  auth: { title: "Authentication", icon: ShieldCheck, blurb: "Firebase admin operations and custom tokens." },
  observability: { title: "Observability", icon: Activity, blurb: "Where server errors are reported." },
};

function SourceBadge({ secret }: { secret: SecretStatus }) {
  if (secret.source === "panel") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/10 text-green-600">
        <CheckCircle2 size={11} /> Saved here
      </span>
    );
  }
  if (secret.source === "environment") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600"
        title="Set as a Cloudflare Worker secret. Saving a value here will override it."
      >
        <Info size={11} /> From server env
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
      <AlertTriangle size={11} /> Not set
    </span>
  );
}

function SecretRow({
  secret,
  disabled,
  onSaved,
}: {
  secret: SecretStatus;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api.setIntegrationSecret(secret.name, value);
      // Clear immediately: the plaintext should not linger in the DOM.
      setValue("");
      toast.success(`${secret.label} saved`);
      onSaved();
    } catch (e: any) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await api.deleteIntegrationSecret(secret.name);
      toast.success(res.message || "Removed");
      onSaved();
    } catch (e: any) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-3 border-b border-border last:border-0">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound size={13} className="text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{secret.label}</span>
          {secret.sensitive && (
            <span
              className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-600"
              title="Platform-level credential with a very large blast radius."
            >
              high risk
            </span>
          )}
        </div>
        <SourceBadge secret={secret} />
      </div>

      {secret.help && <p className="text-xs text-muted-foreground mb-2">{secret.help}</p>}

      <div className="flex flex-col sm:flex-row gap-2">
        {secret.multiline ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={secret.configured ? `Currently ${secret.hint} — paste a new value to replace` : "Paste the JSON key file"}
            rows={4}
            spellCheck={false}
            className={`${field} font-mono text-xs`}
            disabled={disabled || busy}
          />
        ) : (
          <input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={secret.configured ? `Currently ${secret.hint} — enter a new value to rotate` : "Not set"}
            className={`${field} font-mono`}
            disabled={disabled || busy}
          />
        )}
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={disabled || busy || !value.trim()}
            className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40 whitespace-nowrap"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : "Save"}
          </button>
          {secret.source === "panel" && (
            <button
              onClick={remove}
              disabled={disabled || busy}
              title="Remove the value stored here (falls back to the server environment if one is set)"
              className="px-3 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-40"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {secret.source === "panel" && secret.updatedAt && (
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Fingerprint <span className="font-mono">{secret.fingerprint}</span> · updated {fmtDateTime(secret.updatedAt)}
        </p>
      )}
    </div>
  );
}

function TestButton({
  provider,
  needsTarget,
  placeholder,
  beforeTest,
}: {
  provider: string;
  needsTarget?: "phone" | "email";
  placeholder?: string;
  /**
   * Run before the test — used to persist unsaved provider/config changes.
   *
   * The test runs SERVER-SIDE against the SAVED config, but the provider dropdown
   * and most fields are unsaved client state until "Save settings" is pressed. A
   * secret has its own inline Save, so it is easy to save the API key, see "Saved
   * here", switch the gateway, and then test — testing the OLD saved gateway and
   * getting "No SMS gateway is configured". Saving first makes Test mean what the
   * user expects: test what is on screen.
   */
  beforeTest?: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const mut = useMutation({
    mutationFn: async () => {
      if (beforeTest) await beforeTest();
      return api.testIntegration(provider, needsTarget ? { to: target } : {});
    },
    onSuccess: (res: any) =>
      setResult({ ok: !!res.ok, message: res.message || (res.ok ? "Working" : "Failed") }),
    onError: (e: any) => setResult({ ok: false, message: describeError(e) }),
  });

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex flex-col sm:flex-row gap-2">
        {needsTarget && (
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={placeholder}
            className={field}
            type={needsTarget === "email" ? "email" : "tel"}
          />
        )}
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending || (!!needsTarget && !target.trim())}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-semibold hover:bg-secondary/70 disabled:opacity-40 whitespace-nowrap"
        >
          {mut.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={14} />}
          Test connection
        </button>
      </div>
      {result && (
        <div
          className={`mt-2 flex items-start gap-2 text-xs px-3 py-2 rounded-xl ${
            result.ok ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-700"
          }`}
        >
          {result.ok ? <CheckCircle2 size={14} className="mt-px shrink-0" /> : <AlertTriangle size={14} className="mt-px shrink-0" />}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
}

function Card({
  group,
  children,
  secrets,
  disabled,
  onSaved,
  test,
}: {
  group: keyof typeof GROUP_META;
  children?: React.ReactNode;
  secrets: SecretStatus[];
  disabled: boolean;
  onSaved: () => void;
  test?: React.ReactNode;
}) {
  const meta = GROUP_META[group];
  const Icon = meta.icon;
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Icon size={17} />
        </div>
        <div>
          <h3 className="font-bold text-foreground leading-tight">{meta.title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{meta.blurb}</p>
        </div>
      </div>
      {children}
      {secrets.length > 0 && (
        <div className="mt-4">
          {secrets.map((s) => (
            <SecretRow key={s.name} secret={s} disabled={disabled} onSaved={onSaved} />
          ))}
        </div>
      )}
      {test}
    </div>
  );
}

export default function Integrations() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery<IntegrationsResponse>({
    queryKey: ["integrations"],
    queryFn: api.integrations,
  });
  const [cfg, setCfg] = useState<IntegrationsResponse["config"] | null>(null);

  useEffect(() => {
    if (data?.config) setCfg(data.config);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveIntegrations(cfg!),
    onSuccess: () => {
      toast.success("Integration settings saved");
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (e: any) => toast.error(describeError(e)),
  });

  /**
   * Do the on-screen settings differ from what is saved?
   *
   * The Test buttons run against the SAVED config, so an unsaved provider change
   * would test the wrong gateway. This drives both a visible "unsaved changes"
   * hint and an auto-save before any test.
   */
  const dirty = useMemo(
    () => !!cfg && !!data?.config && JSON.stringify(cfg) !== JSON.stringify(data.config),
    [cfg, data],
  );
  const saveIfDirty = async () => {
    if (dirty) await saveMut.mutateAsync();
  };

  const byGroup = useMemo(() => {
    const map: Record<string, SecretStatus[]> = {};
    for (const s of data?.secrets ?? []) (map[s.group] ??= []).push(s);
    return map;
  }, [data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });

  // A failed load must not render as "Loading…" forever. `cfg` only becomes
  // non-null once a response arrives, so without an explicit error branch any
  // rejected request left this page spinning with nothing to retry.
  if (isError) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm flex flex-col gap-3 sm:flex-row sm:items-center">
        <AlertTriangle className="text-destructive shrink-0" size={18} />
        <p className="flex-1">Could not load integrations: {describeError(error)}</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted/40 shrink-0"
        >
          Retry
        </button>
      </div>
    );
  }

  if (isLoading || !cfg) {
    return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;
  }

  const noStorage = data && !data.secretStorage;
  // SMS credentials are grouped per provider so the page only shows what the
  // selected gateway actually needs.
  const smsSecretsFor: Record<string, string[]> = {
    twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    msg91: ["MSG91_AUTH_KEY"],
    fast2sms: ["FAST2SMS_API_KEY"],
    hanuotp: ["HANUOTP_API_KEY"],
    custom: ["SMS_CUSTOM_TOKEN"],
    none: [],
  };
  const smsSecrets = (byGroup.sms ?? []).filter((s) =>
    (smsSecretsFor[cfg.sms.provider] ?? []).includes(s.name),
  );
  const emailSecrets = (byGroup.email ?? []).filter((s) =>
    cfg.email.provider === "brevo" ? s.name === "BREVO_API_KEY" : s.name === "RESEND_API_KEY",
  );

  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="SMS, email, payments, video and storage — all configurable without a deploy"
        action={
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !dirty}
            title={dirty ? "You have unsaved changes" : "Nothing to save"}
            className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
          >
            <Save size={15} /> {dirty ? "Save changes" : "Saved"}
            {dirty && <span className="ml-1 w-2 h-2 rounded-full bg-white/90" aria-hidden />}
          </button>
        }
      />

      {noStorage && (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-5">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Credentials cannot be saved yet</p>
            <p className="text-xs mt-1">
              The server has no encryption key, so keys entered here cannot be stored securely and saving
              is disabled. Generate one with <code className="font-mono">openssl rand -base64 32</code> and set it with{" "}
              <code className="font-mono">wrangler secret put SETTINGS_ENCRYPTION_KEY</code>. Provider settings
              below can still be changed, and any credential already in the server environment keeps working.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-xl px-4 py-3 mb-5">
        <Eye size={15} className="mt-0.5 shrink-0" />
        <span>
          Saved credentials are encrypted and can never be read back — not by this page, not by the API.
          You will only ever see a masked hint and a fingerprint. To change one, enter a new value.
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* ---------------- SMS ---------------- */}
        <Card
          group="sms"
          secrets={smsSecrets}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="sms" needsTarget="phone" placeholder="Send a test code to (e.g. 9876543210)" beforeTest={saveIfDirty} />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className={label}>Active gateway</label>
              <select
                value={cfg.sms.provider}
                onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, provider: e.target.value as any } })}
                className={field}
              >
                <option value="none">Disabled (no SMS will be sent)</option>
                <option value="twilio">Twilio</option>
                <option value="msg91">MSG91 (India, DLT)</option>
                <option value="fast2sms">Fast2SMS (India, DLT)</option>
                <option value="hanuotp">HanuOTP (India, non-DLT OTP)</option>
                <option value="custom">Custom HTTP gateway</option>
              </select>
            </div>

            {/* HanuOTP is non-DLT: it has no sender ID and its template defaults to
                "default", so it needs only its API key below. Nothing to show here. */}
            {cfg.sms.provider !== "none" &&
              cfg.sms.provider !== "custom" &&
              cfg.sms.provider !== "hanuotp" && (
              <div>
                <label className={label}>
                  {cfg.sms.provider === "twilio" ? "Sender number (E.164)" : "DLT sender ID"}
                </label>
                <input
                  value={cfg.sms.from}
                  onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, from: e.target.value } })}
                  placeholder={cfg.sms.provider === "twilio" ? "+14155552671" : "TOPHNT"}
                  className={field}
                />
              </div>
            )}

            {cfg.sms.provider === "hanuotp" && (
              <div className="sm:col-span-2">
                <label className={label}>Template ID (optional)</label>
                <input
                  value={cfg.sms.templateId}
                  onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, templateId: e.target.value } })}
                  placeholder="default"
                  className={field}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Sent as <code className="font-mono">templatesid</code>. Leave blank to use{" "}
                  <code className="font-mono">default</code>. Add the API key below.
                </p>
              </div>
            )}

            {(cfg.sms.provider === "msg91" || cfg.sms.provider === "fast2sms") && (
              <div>
                <label className={label}>DLT template / flow ID</label>
                <input
                  value={cfg.sms.templateId}
                  onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, templateId: e.target.value } })}
                  className={field}
                />
              </div>
            )}

            {cfg.sms.provider === "msg91" && (
              <div>
                <label className={label}>OTP variable name</label>
                <input
                  value={cfg.sms.otpVariable}
                  onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, otpVariable: e.target.value } })}
                  placeholder="otp"
                  className={field}
                />
              </div>
            )}

            {cfg.sms.provider === "fast2sms" && (
              <div>
                <label className={label}>Route</label>
                <select
                  value={cfg.sms.route}
                  onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, route: e.target.value } })}
                  className={field}
                >
                  <option value="dlt">dlt (approved template)</option>
                  <option value="otp">otp (quick OTP route)</option>
                  <option value="q">q (transactional)</option>
                </select>
              </div>
            )}

            {cfg.sms.provider === "custom" && (
              <>
                <div className="sm:col-span-2">
                  <label className={label}>Gateway URL</label>
                  <input
                    value={cfg.sms.customUrl}
                    onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, customUrl: e.target.value } })}
                    placeholder="https://gateway.example.com/send?key={token}&to={to}&text={message}"
                    className={`${field} font-mono text-xs`}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Placeholders: <code className="font-mono">{"{to}"}</code>{" "}
                    <code className="font-mono">{"{to_e164}"}</code>{" "}
                    <code className="font-mono">{"{message}"}</code>{" "}
                    <code className="font-mono">{"{code}"}</code>{" "}
                    <code className="font-mono">{"{token}"}</code>. Must be https.
                  </p>
                </div>
                <div>
                  <label className={label}>Method</label>
                  <select
                    value={cfg.sms.customMethod}
                    onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, customMethod: e.target.value as any } })}
                    className={field}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
                {cfg.sms.customMethod === "POST" && (
                  <div className="sm:col-span-2">
                    <label className={label}>JSON body template</label>
                    <textarea
                      value={cfg.sms.customBody}
                      onChange={(e) => setCfg({ ...cfg, sms: { ...cfg.sms, customBody: e.target.value } })}
                      rows={3}
                      placeholder={'{"to":"{to}","text":"{message}"}'}
                      className={`${field} font-mono text-xs`}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        {/* ---------------- Email ---------------- */}
        <Card
          group="email"
          secrets={emailSecrets}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="email" needsTarget="email" placeholder="Send a test email to…" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Provider</label>
              <select
                value={cfg.email.provider}
                onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, provider: e.target.value as any } })}
                className={field}
              >
                <option value="none">Disabled</option>
                <option value="resend">Resend</option>
                <option value="brevo">Brevo</option>
              </select>
            </div>
            <div>
              <label className={label}>From address</label>
              <input
                value={cfg.email.from}
                onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, from: e.target.value } })}
                placeholder="TopHunt &lt;no-reply@tophunt.in&gt;"
                className={field}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>Reply-to (optional)</label>
              <input
                value={cfg.email.replyTo}
                onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, replyTo: e.target.value } })}
                placeholder="support@tophunt.in"
                className={field}
              />
            </div>
          </div>
        </Card>

        {/* ---------------- Payments ---------------- */}
        <Card
          group="payments"
          secrets={byGroup.payments ?? []}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="razorpay" />}
        >
          <div>
            <label className={label}>Razorpay Key ID (public)</label>
            <input
              value={cfg.payments.razorpayKeyId}
              onChange={(e) => setCfg({ ...cfg, payments: { razorpayKeyId: e.target.value } })}
              placeholder="rzp_live_xxxxxxxx"
              className={`${field} font-mono`}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              This one is not secret — the app sends it to the checkout SDK. The key secret below is.
            </p>
          </div>
        </Card>

        {/* ---------------- Video ---------------- */}
        <Card
          group="video"
          secrets={byGroup.video ?? []}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="bunny" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className={label}>Video delivery</label>
              <select
                value={cfg.video.provider}
                onChange={(e) => setCfg({ ...cfg, video: { ...cfg.video, provider: e.target.value as any } })}
                className={field}
              >
                <option value="r2">R2 only (direct upload, no transcoding)</option>
                <option value="bunny">Bunny Stream (transcoded, adaptive)</option>
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Switching back to R2 is a safe kill-switch: uploads keep working even with Bunny credentials present.
              </p>
            </div>
            <div>
              <label className={label}>Library ID</label>
              <input
                value={cfg.video.libraryId}
                onChange={(e) => setCfg({ ...cfg, video: { ...cfg.video, libraryId: e.target.value } })}
                placeholder="123456"
                className={`${field} font-mono`}
              />
            </div>
            <div>
              <label className={label}>Pull-zone hostname</label>
              <input
                value={cfg.video.cdnHostname}
                onChange={(e) => setCfg({ ...cfg, video: { ...cfg.video, cdnHostname: e.target.value } })}
                placeholder="vz-xxxxxxxx-xxx.b-cdn.net"
                className={`${field} font-mono`}
              />
            </div>
          </div>
        </Card>

        {/* ---------------- Storage ---------------- */}
        <Card group="storage" secrets={byGroup.storage ?? []} disabled={!!noStorage} onSaved={refresh} />

        {/* ---------------- Auth ---------------- */}
        <Card
          group="auth"
          secrets={byGroup.auth ?? []}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="firebase" />}
        />

        {/* ---------------- Push + observability ---------------- */}
        <Card
          group="observability"
          secrets={byGroup.observability ?? []}
          disabled={!!noStorage}
          onSaved={refresh}
          test={<TestButton provider="sentry" />}
        >
          <div>
            <label className={label}>Web push VAPID public key</label>
            <input
              value={cfg.push.vapidPublicKey}
              onChange={(e) => setCfg({ ...cfg, push: { vapidPublicKey: e.target.value } })}
              placeholder="B..."
              className={`${field} font-mono text-xs`}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Public by design. Required for web push; native push uses FCM directly.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
