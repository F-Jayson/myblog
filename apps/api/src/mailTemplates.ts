function escapeHtml(text: string): string {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export type VerificationCodeMailOptions = {
	siteName: string;
	code: string;
	ttlMinutes: number;
	email: string;
	purpose?: string;
	siteUrl?: string;
};

export function renderVerificationCodeEmail(options: VerificationCodeMailOptions): { subject: string; text: string; html: string } {
	const siteName = options.siteName || "Jayson's Blog";
	const purpose = options.purpose || "注册验证码";
	const code = options.code.trim();
	const ttlMinutes = options.ttlMinutes || 15;
	const siteUrl = (options.siteUrl || "https://blog.fjayson.com").replace(/\/+$/u, "");
	const currentYear = new Date().getFullYear();

	const subject = `【${siteName}】${purpose}：${code}`;
	const text = `您好！\n\n您正在 ${siteName} 进行账号注册或身份验证，本次验证码为：\n\n【 ${code} 】\n\n该验证码在 ${ttlMinutes} 分钟内有效。为了保障您的账号安全，请勿将验证码提供给他人。\n如非您本人操作，请忽略此邮件。\n\n${siteName}\n${siteUrl}`;

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHtml(subject)}</title>
<!--[if mso]>
<style type="text/css">
body, table, td, h1, h2, h3, p, a, span { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  body { margin: 0; padding: 0; min-width: 100%; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #f4f6fb; }
  table { border-spacing: 0; border-collapse: collapse; }
  img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
  @media only screen and (max-width: 600px) {
    .email-container { width: 100% !important; padding: 12px !important; }
    .card-body { padding: 24px 20px !important; }
    .code-box { font-size: 28px !important; letter-spacing: 6px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; color: #1e293b;">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f6fb; padding: 40px 10px;">
  <tr>
    <td align="center">
      <!--[if (gte mso 9)|(IE)]>
      <table align="center" border="0" cellspacing="0" cellpadding="0" width="560">
      <tr>
      <td align="center" valign="top" width="560">
      <![endif]-->
      <table class="email-container" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06); border: 1px solid #e2e8f0;">
        <!-- Header with brand gradient -->
        <tr>
          <td style="background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 55%, #3b82f6 100%); padding: 32px 36px 28px; text-align: left;">
            <table border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td>
                  <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 6px 12px; margin-bottom: 12px;">
                    <span style="color: #ffffff; font-size: 13px; font-weight: 600; letter-spacing: 0.5px;">✨ 安全验证中心</span>
                  </div>
                  <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; line-height: 1.3; letter-spacing: 0.2px;">
                    ${escapeHtml(siteName)}
                  </h1>
                  <p style="margin: 6px 0 0 0; color: rgba(255, 255, 255, 0.85); font-size: 13px; line-height: 1.4;">
                    电子邮箱身份确认
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card Body -->
        <tr>
          <td class="card-body" style="padding: 36px 36px 32px; background-color: #ffffff;">
            <p style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #0f172a; line-height: 1.5;">
              您好！
            </p>
            <p style="margin: 0 0 24px 0; font-size: 14px; color: #475569; line-height: 1.65;">
              您正在进行 <strong>${escapeHtml(siteName)}</strong> 的${escapeHtml(purpose)}操作。为保障您的账号安全，请在验证码输入框中填入下方验证码：
            </p>

            <!-- Verification Code Card -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
              <tr>
                <td style="background-color: #f0f7ff; border: 1.5px dashed #93c5fd; border-radius: 12px; padding: 24px 20px; text-align: center;">
                  <div class="code-box" style="font-family: 'SF Mono', Consolas, Monaco, 'Courier New', monospace; font-size: 36px; font-weight: 800; color: #1d4ed8; letter-spacing: 10px; line-height: 1.1; padding-left: 10px;">
                    ${escapeHtml(code)}
                  </div>
                  <div style="margin-top: 12px; display: inline-block; background-color: #ffffff; padding: 4px 14px; border-radius: 12px; font-size: 12px; color: #64748b; font-weight: 500; border: 1px solid #e2e8f0;">
                    ⏱️ 有效期 <strong>${ttlMinutes}</strong> 分钟 · 请尽快填写
                  </div>
                </td>
              </tr>
            </table>

            <!-- Security Notice Box -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border-radius: 10px; border: 1px solid #edf2f7; margin-bottom: 8px;">
              <tr>
                <td style="padding: 16px 18px;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td valign="top" style="width: 22px; padding-top: 1px;">
                        <span style="font-size: 15px;">🔒</span>
                      </td>
                      <td style="font-size: 13px; color: #64748b; line-height: 1.6;">
                        <strong>安全提示</strong>：任何工作人员均不会向您索取该验证码。请勿将其泄露或转发给任何人。
                      </td>
                    </tr>
                    <tr>
                      <td valign="top" style="width: 22px; padding-top: 6px;">
                        <span style="font-size: 15px;">⚠️</span>
                      </td>
                      <td style="padding-top: 5px; font-size: 13px; color: #64748b; line-height: 1.6;">
                        如非您本人发起的请求，请忽略此邮件，您的账号安全不会受到任何影响。
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color: #f8fafc; border-top: 1px solid #f1f5f9; padding: 24px 36px; text-align: center;">
            <div style="margin-bottom: 14px;">
              <a href="${escapeHtml(siteUrl)}" target="_blank" style="display: inline-block; padding: 7px 18px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; color: #475569; font-size: 13px; text-decoration: none; font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);">
                🌐 前往网站：${escapeHtml(siteName)}
              </a>
            </div>
            <p style="margin: 0 0 6px 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
              此邮件由系统自动发送，请勿直接回复本邮件。
            </p>
            <p style="margin: 0; font-size: 12px; color: #cbd5e1; line-height: 1.5;">
              © ${currentYear} ${escapeHtml(siteName)}. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
      <!--[if (gte mso 9)|(IE)]>
      </td>
      </tr>
      </table>
      <![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;

	return { subject, text, html };
}

export type NotificationMailOptions = {
	siteName: string;
	title: string;
	lines: string[];
	siteUrl?: string;
};

export function renderNotificationEmail(options: NotificationMailOptions): { subject: string; text: string; html: string } {
	const siteName = options.siteName || "Jayson's Blog";
	const title = options.title || "系统提醒";
	const siteUrl = (options.siteUrl || "https://blog.fjayson.com").replace(/\/+$/u, "");
	const currentYear = new Date().getFullYear();

	const subject = `【${siteName}】${title}`;
	const text = `${title}\n\n${options.lines.join("\n")}\n\n${siteName}\n${siteUrl}`;

	const listRows = options.lines.map((line) => {
		const parts = line.split("：");
		if (parts.length >= 2) {
			const label = parts[0] + "：";
			const value = parts.slice(1).join("：");
			return `<tr>
        <td style="padding: 8px 0; font-size: 13px; color: #64748b; width: 80px; vertical-align: top; font-weight: 600;">${escapeHtml(label)}</td>
        <td style="padding: 8px 0; font-size: 14px; color: #1e293b; vertical-align: top; word-break: break-all;">${escapeHtml(value)}</td>
      </tr>`;
		}
		return `<tr>
      <td colspan="2" style="padding: 8px 0; font-size: 14px; color: #334155; line-height: 1.6;">${escapeHtml(line)}</td>
    </tr>`;
	}).join("\n");

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1e293b;">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f6fb; padding: 40px 10px;">
  <tr>
    <td align="center">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06); border: 1px solid #e2e8f0;">
        <tr>
          <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 28px 36px; text-align: left;">
            <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700; line-height: 1.3;">
              ${escapeHtml(siteName)} · 管理提醒
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 32px 36px 28px; background-color: #ffffff;">
            <h2 style="margin: 0 0 16px 0; font-size: 17px; font-weight: 700; color: #0f172a;">
              ${escapeHtml(title)}
            </h2>
            <div style="background-color: #f8fafc; border-radius: 10px; border: 1px solid #edf2f7; padding: 18px 22px; margin-bottom: 20px;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                ${listRows}
              </table>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background-color: #f8fafc; border-top: 1px solid #f1f5f9; padding: 20px 36px; text-align: center;">
            <a href="${escapeHtml(siteUrl)}" target="_blank" style="display: inline-block; padding: 6px 16px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; color: #475569; font-size: 13px; text-decoration: none; font-weight: 500;">
              🌐 前往管理后台
            </a>
            <p style="margin: 12px 0 0 0; font-size: 12px; color: #94a3b8;">
              © ${currentYear} ${escapeHtml(siteName)}. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

	return { subject, text, html };
}
