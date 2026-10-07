require('dotenv').config();
const express = require('express');
const jsforce = require('jsforce');

const app = express();
app.use(express.json());

// ==========================================
// SALESFORCE CONNECTION (race-condition safe)
// ==========================================
let sfConn = null;        // only ever holds a fully logged-in connection
let loginPromise = null;  // in-flight login; concurrent requests wait on this

function sfBaseUrl() {
  let url = process.env.SF_LOGIN_URL || 'https://ownercom--qa.sandbox.my.salesforce.com';
  if (!url.startsWith('http')) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function getSalesforceConnection() {
  if (sfConn) return sfConn;
  if (loginPromise) return loginPromise; // only one login even if requests arrive at the same time

  loginPromise = (async () => {
    const conn = new jsforce.Connection({ loginUrl: sfBaseUrl(), version: '57.0' });
    await conn.login(
      process.env.SF_USERNAME,
      process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
    );
    if (conn.instanceUrl && !conn.instanceUrl.startsWith('http')) {
      conn.instanceUrl = `https://${conn.instanceUrl}`;
    }
    sfConn = conn; // publish the connection only after login has completed
    console.log('Salesforce login OK:', conn.instanceUrl);
    return conn;
  })().finally(() => { loginPromise = null; });

  return loginPromise;
}

// Use this for ALL Salesforce calls. Retries once if the session is expired/invalid.
async function withSf(fn) {
  let conn = await getSalesforceConnection();
  try {
    return await fn(conn);
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    if (err.errorCode === 'INVALID_SESSION_ID' || /session|Failed to parse URL/i.test(msg)) {
      if (sfConn === conn) sfConn = null; // only reset if this is still the shared connection
      conn = await getSalesforceConnection();
      return await fn(conn);
    }
    throw err;
  }
}

// ==========================================
// HELPERS
// ==========================================
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const isSfId = s => /^[a-zA-Z0-9]{15,18}$/.test(s || '');

function formatAddress(addr) {
  if (!addr) return "N/A";
  if (typeof addr === 'string') return addr;
  const parts = [addr.street, addr.city, addr.state, addr.postalCode, addr.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : "N/A";
}

function extractSfCaseId(body) {
  const id = body.conversation?.custom_attributes?.salesforce_id
      || body.conversation?.custom_attributes?.salesforce_case_id
      || body.conversation?.custom_attributes?.sf_case_id
      || body.custom_attributes?.salesforce_id
      || body.custom_attributes?.salesforce_case_id
      || body.customer?.custom_attributes?.salesforce_id
      || body.customer?.custom_attributes?.salesforce_case_id
      || body.user?.custom_attributes?.salesforce_id
      || body.user?.custom_attributes?.salesforce_case_id;
  return isSfId(id) ? id : undefined;
}

function safeParseFloat(val) {
  if (val === undefined || val === null || val === "") return null;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? null : parsed;
}

const str = v => (v === undefined || v === null) ? "" : String(v);

// ==========================================
// CASE FIELD RESOLUTION (describe-based)
// The query is not hardcoded. Only fields that actually exist on Case
// (and are visible to the integration user) are included, so one wrong
// or inaccessible field can no longer break the whole form.
// ==========================================
const REFUND_FIELDS = {
  order_id:                         { names: ['Order_ID__c'] },
  date_of_order:                    { names: ['Date_of_Order__c'] },
  guest_name:                       { names: ['Guest_Name__c'] },
  order_type:                       { names: ['Order_Type__c'] },
  delivery_order_id:                { names: ['Delivery_Order_ID__c'] },
  delivery_partner:                 { names: ['Delivery_Partner__c'] },
  dispute_id:                       { names: ['Dispute_ID__c'] },
  amount_issued_account:            { names: ['Amount_Issued_to_Customer_Account__c'], numeric: true },
  amount_issued_guest:              { names: ['Amount_Issued_to_Guest__c'], numeric: true },
  refund_reason_notes:              { names: ['Refund_Reason_Notes__c'] },
  third_party_reimbursement_amount: {
    names: ['Third_Party_Reimbursement_Amount__c', 'X3rd_Party_Reimbursement_Amount__c', 'X3rd_Party_Reimbursement_Amt__c', 'Third_Party_Reimbursement_Amt__c'],
    match: /(3rd|third).*party.*reimburs.*(amount|amt)/i,
    numeric: true
  },
  third_party_reimbursement_status: {
    names: ['Third_Party_Reimbursement_Status__c', 'X3rd_Party_Reimbursement_Status__c'],
    match: /(3rd|third).*party.*reimburs.*status/i
  },
  stripe_reimbursement_link:        { names: ['Stripe_Reimbursement_Link__c'], match: /stripe.*reimburs/i },
  refund_complete:                  { names: ['Refund_Complete__c'], boolean: true }
};

let caseMeta = null;
let caseMetaPromise = null;
let caseMetaAt = 0;
const CASE_META_TTL_MS = 60 * 60 * 1000; // refresh describe (picklists etc.) every hour

async function loadCaseFieldMeta() {
  if (caseMeta && Date.now() - caseMetaAt > CASE_META_TTL_MS) {
    caseMeta = null;
    caseMetaPromise = null;
  }
  if (caseMeta) return caseMeta;
  if (!caseMetaPromise) {
    caseMetaPromise = withSf(conn => conn.sobject('Case').describe())
      .then(desc => {
        const byLower = new Map();
        desc.fields.forEach(f => byLower.set(f.name.toLowerCase(), f));

        const resolved = {};
        for (const [key, def] of Object.entries(REFUND_FIELDS)) {
          let f = null;
          for (const n of def.names) {
            f = byLower.get(n.toLowerCase());
            if (f) break;
          }
          if (!f && def.match) f = desc.fields.find(x => def.match.test(x.name));
          if (f) resolved[key] = f;
          else console.warn(`⚠️ No matching Salesforce field found for "${key}" (tried: ${def.names.join(', ')})`);
        }

        const hints = desc.fields.filter(f => /reimburs|stripe/i.test(f.name)).map(f => f.name);
        console.log('Case fields matching "reimburs/stripe":', hints.join(', ') || '(none)');

        caseMeta = { byLower, resolved };
        caseMetaAt = Date.now();
        return caseMeta;
      })
      .catch(err => { caseMetaPromise = null; throw err; });
  }
  return caseMetaPromise;
}

async function fetchCase(sfCaseId) {
  const meta = await loadCaseFieldMeta();
  const fields = new Set(['Id']);
  ['Source__c', 'ContactId', 'AccountId'].forEach(n => {
    const f = meta.byLower.get(n.toLowerCase());
    if (f) fields.add(f.name);
  });
  Object.values(meta.resolved).forEach(f => fields.add(f.name));

  const soql = `SELECT ${[...fields].join(', ')} FROM Case WHERE Id = '${esc(sfCaseId)}' LIMIT 1`;
  const result = await withSf(conn => conn.query(soql));
  return (result.records && result.records[0]) || null;
}

// ==========================================
// APP 1: REFUND DETAILS APP
// ==========================================
function buildRefundForm(values = {}, message = null) {
  const components = [];

  if (message) {
    components.push({ type: "text", text: message, style: "header" });
  }

  components.push(
    { type: "input", id: "order_id", label: "Order ID", value: values.order_id || "" },
    { type: "input", id: "date_of_order", label: "Date of Order", value: values.date_of_order || "", placeholder: "YYYY-MM-DD" },
    { type: "input", id: "guest_name", label: "Guest Name", value: values.guest_name || "" },
    {
      type: "dropdown",
      id: "order_type",
      label: "Order Type",
      options: [
        { type: "option", id: "Delivery", text: "Delivery" },
        { type: "option", id: "Pickup", text: "Pickup" },
        { type: "option", id: "Dispute", text: "Dispute" },
        { type: "option", id: "Other", text: "Other" }
      ],
      value: values.order_type || "Delivery"
    },
    { type: "input", id: "delivery_order_id", label: "Delivery Order ID", value: values.delivery_order_id || "" },
    {
      type: "dropdown",
      id: "delivery_partner",
      label: "Delivery Partner",
      options: [
        { type: "option", id: "", text: "-- Select --" },
        { type: "option", id: "DoorDash", text: "DoorDash" },
        { type: "option", id: "UberEats", text: "UberEats" },
        { type: "option", id: "Other", text: "Other" }
      ],
      value: values.delivery_partner || ""
    },
    { type: "input", id: "dispute_id", label: "Dispute ID", value: values.dispute_id || "" },
    { type: "input", id: "amount_issued_account", label: "Amount Issued to Customer (Account)", value: values.amount_issued_account || "" },
    { type: "input", id: "amount_issued_guest", label: "Amount Issued to Guest", value: values.amount_issued_guest || "" },
    { type: "textarea", id: "refund_reason_notes", label: "Refund Reason Notes", value: values.refund_reason_notes || "" },
    { type: "input", id: "third_party_reimbursement_amount", label: "3rd Party Reimbursement Amount", value: values.third_party_reimbursement_amount || "" },
    {
      type: "dropdown",
      id: "third_party_reimbursement_status",
      label: "3rd Party Reimbursement Status",
      options: [
        { type: "option", id: "", text: "-- Select --" },
        { type: "option", id: "Approved", text: "Approved" },
        { type: "option", id: "Denied", text: "Denied" },
        { type: "option", id: "N/A", text: "N/A" }
      ],
      value: values.third_party_reimbursement_status || ""
    },
    { type: "input", id: "stripe_reimbursement_link", label: "Stripe Reimbursement Link", value: values.stripe_reimbursement_link || "" },
    {
      type: "dropdown",
      id: "refund_complete",
      label: "Refund Complete",
      options: [
        { type: "option", id: "", text: "-- Select --" },
        { type: "option", id: "Yes", text: "Yes" },
        { type: "option", id: "No", text: "No" }
      ],
      value: values.refund_complete || ""
    },
    { type: "button", id: "submit_refund", label: "Update Salesforce Ticket", style: "primary", action: { type: "submit" } }
  );

  return components;
}

// INITIALIZE REFUND APP
app.post('/intercom/initialize', async (req, res) => {
  const sfCaseId = extractSfCaseId(req.body);
  console.log('REFUND INIT sfCaseId =', sfCaseId, '| conv id =', req.body.conversation?.id);

  let existingValues = {};
  let notice = null;

  if (sfCaseId) {
    try {
      const meta = await loadCaseFieldMeta();
      const rec = await fetchCase(sfCaseId);
      if (rec) {
        const R = meta.resolved;
        const get = k => (R[k] ? rec[R[k].name] : undefined);

        const rc = get('refund_complete');
        existingValues = {
          order_id: str(get('order_id')),
          date_of_order: str(get('date_of_order')),
          guest_name: str(get('guest_name')),
          order_type: str(get('order_type')) || "Delivery",
          delivery_order_id: str(get('delivery_order_id')),
          delivery_partner: str(get('delivery_partner')),
          dispute_id: str(get('dispute_id')),
          amount_issued_account: str(get('amount_issued_account')),
          amount_issued_guest: str(get('amount_issued_guest')),
          refund_reason_notes: str(get('refund_reason_notes')),
          third_party_reimbursement_amount: str(get('third_party_reimbursement_amount')),
          third_party_reimbursement_status: str(get('third_party_reimbursement_status')),
          stripe_reimbursement_link: str(get('stripe_reimbursement_link')),
          refund_complete: rc === true ? "Yes" : rc === false ? "No" : ""
        };
      } else {
        notice = "⚠️ Salesforce ticket not found";
      }
    } catch (err) {
      console.error("Refund App Initialize Error:", err.message);
      notice = `⚠️ Could not load data from Salesforce: ${err.message}`;
    }
  }

  res.json({ canvas: { content: { components: buildRefundForm(existingValues, notice) } } });
});

// SUBMIT REFUND APP
app.post('/intercom/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const sfCaseId = extractSfCaseId(req.body);

  try {
    if (!sfCaseId) {
      throw new Error("No Salesforce ticket is linked to this conversation");
    }

    const meta = await loadCaseFieldMeta();
    const sfData = { Id: sfCaseId };
    const skipped = [];

    for (const [key, def] of Object.entries(REFUND_FIELDS)) {
      const f = meta.resolved[key];
      if (!f) { skipped.push(key); continue; }
      if (!f.updateable) { skipped.push(key); continue; }

      if (def.boolean) {
        if (inputs[key] === "Yes") sfData[f.name] = true;
        else if (inputs[key] === "No") sfData[f.name] = false;
        // blank = leave the field untouched
      } else if (def.numeric) {
        sfData[f.name] = safeParseFloat(inputs[key]);
      } else {
        sfData[f.name] = inputs[key] || null; // blank = null
      }
    }

    await withSf(conn => conn.sobject('Case').update(sfData));
    console.log(`Successfully updated Refund details for Case ${sfCaseId}`);

    let msg = "✅ Refund details updated to Salesforce ticket";
    if (skipped.length > 0) msg += ` (not saved: ${skipped.join(', ')})`;

    res.json({ canvas: { content: { components: buildRefundForm(inputs, msg) } } });
  } catch (error) {
    console.error("Refund Submit Error:", error.message);
    res.json({
      canvas: { content: { components: buildRefundForm(inputs, `❌ Save Error: ${error.message}`) } }
    });
  }
});

// ==========================================
// APP 2: SALESFORCE CASE MANAGER APP
// ==========================================
function buildAccountContactUI(values = {}, options = {}, message = null) {
  const components = [];

  if (message) {
    components.push({ type: "text", text: message, style: "header" });
  }

  // 1. GO TO SALESFORCE TICKET BUTTON
  if (values.sfCaseId) {
    const caseUrl = `${sfBaseUrl()}/${values.sfCaseId}`;
    components.push(
      {
        type: "button",
        id: "open_sf_ticket_btn",
        label: "🔗 Go to Salesforce Ticket",
        style: "primary",
        action: { type: "url", url: caseUrl }
      },
      { type: "divider" }
    );
  }

  // 2. CONTACT SEARCH BLOCK
  components.push(
    { type: "input", id: "contact_search_term", label: "Search Contact", value: values.contact_search_term || "", placeholder: "Name, email, or phone..." },
    { type: "button", id: "search_contact_btn", label: "🔍 Search Contact", style: "secondary", action: { type: "submit" } }
  );

  if (options.contactList && options.contactList.length > 0) {
    const contactDropdown = options.contactList.map(c => ({
      type: "option",
      id: c.Id,
      text: `${c.Name} (${c.Email || c.Phone || 'No Email/Phone'})`
    }));
    components.push({
      type: "dropdown",
      id: "selected_contact_id",
      label: "Select Matching Contact",
      options: contactDropdown,
      value: values.selected_contact_id || contactDropdown[0].id,
      action: { type: "submit" }
    });
  }

  components.push(
    { type: "text", text: `*Contact Email:* ${values.contact_email || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Contact Phone:* ${values.contact_phone || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Contact Status:* ${values.contact_status || 'N/A'}`, style: "paragraph" },
    { type: "divider" }
  );

  // 3. ACCOUNT SEARCH BLOCK
  components.push(
    { type: "input", id: "account_search_term", label: "Search Account", value: values.account_search_term || "", placeholder: "Type account name..." },
    { type: "button", id: "search_account_btn", label: "🔍 Search Account", style: "secondary", action: { type: "submit" } }
  );

  if (options.accountList && options.accountList.length > 0) {
    const accountDropdown = options.accountList.map(a => ({
      type: "option",
      id: a.Id,
      text: `${a.Name}`
    }));
    components.push({
      type: "dropdown",
      id: "selected_account_id",
      label: "Select Matching Account",
      options: accountDropdown,
      value: values.selected_account_id || accountDropdown[0].id,
      action: { type: "submit" }
    });
  }

  components.push(
    { type: "text", text: `*Account Status:* ${values.account_status || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Partner Level:* ${values.partner_level || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*GP Score:* ${values.gp_score || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Next Stripe Invoice Date:* ${values.next_stripe_invoice_date || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Website:* ${values.website || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Dashboard URL:* ${values.dashboard_url || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Billing Address:* ${values.billing_address || 'N/A'}`, style: "paragraph" },
    { type: "divider" }
  );

  // 4. SOURCE DROPDOWN
  components.push({
    type: "dropdown",
    id: "source",
    label: "Source",
    options: [
      { type: "option", id: "", text: "-- Select Source --" },
      { type: "option", id: "Customer - Live", text: "Customer - Live" },
      { type: "option", id: "Customer - Churned", text: "Customer - Churned" },
      { type: "option", id: "Customer - Onboarding", text: "Customer - Onboarding" },
      { type: "option", id: "Inbound Lead", text: "Inbound Lead" },
      { type: "option", id: "Guest", text: "Guest" },
      { type: "option", id: "Google", text: "Google" },
      { type: "option", id: "Other", text: "Other" }
    ],
    value: values.source || "",
    action: { type: "submit" }
  });

  return components;
}

// Map Contact/Account records into form values (handled separately so one failure doesn't affect the other)
// Related_Account_IDs__c on Contact is a long text field with comma/space/newline separated Account IDs
function parseRelatedAccountIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(isSfId);
  return String(raw).split(/[\s,;]+/).map(x => x.trim()).filter(isSfId);
}

// Show dates as YYYY-MM-DD (works for both Date and DateTime fields)
function formatDateValue(v) {
  if (!v) return "N/A";
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function applyContactValues(target, c) {
  target.contact_search_term = c.Name || "";
  target.contact_email = c.Email || "N/A";
  target.contact_phone = c.Phone || "N/A";
  target.contact_status = c.Contact_Status__c || "N/A";
}

function applyAccountValues(target, a) {
  target.account_search_term = a.Name || "";
  target.account_status = a.Account_Status__c || "N/A";
  target.partner_level = a.Partner_Level__c || "N/A";
  target.gp_score = (a.GP_Score__c === undefined || a.GP_Score__c === null) ? "N/A" : String(a.GP_Score__c); // 0 is a valid score
  target.next_stripe_invoice_date = formatDateValue(a.next_stripe_invoice_date__c);
  target.website = a.Website || "N/A";
  target.dashboard_url = a.Dashboard_URL__c || "N/A";
  target.billing_address = formatAddress(a.BillingAddress);
}

// INITIALIZE CASE MANAGER APP
app.post('/intercom/account-app/initialize', async (req, res) => {
  const sfCaseId = extractSfCaseId(req.body);
  console.log('CASE MGR INIT sfCaseId =', sfCaseId, '| conv id =', req.body.conversation?.id);

  const initialValues = { sfCaseId };
  let contactList = [];
  let accountList = [];
  let notice = null;

  if (sfCaseId) {
    try {
      const sfCase = await fetchCase(sfCaseId);

      if (sfCase) {
        initialValues.source = sfCase.Source__c || "";

        const [contactRecord, accountRecord] = await Promise.all([
          sfCase.ContactId
            ? withSf(c => c.sobject('Contact').retrieve(sfCase.ContactId)).catch(e => { console.error('Contact retrieve error:', e.message); return null; })
            : null,
          sfCase.AccountId
            ? withSf(c => c.sobject('Account').retrieve(sfCase.AccountId)).catch(e => { console.error('Account retrieve error:', e.message); return null; })
            : null
        ]);

        if (sfCase.ContactId) {
          initialValues.selected_contact_id = sfCase.ContactId;
          if (contactRecord) {
            applyContactValues(initialValues, contactRecord);
            contactList = [contactRecord];
          }
        }

        if (sfCase.AccountId) {
          initialValues.selected_account_id = sfCase.AccountId;
          if (accountRecord) {
            applyAccountValues(initialValues, accountRecord);
            accountList = [accountRecord];
          }
        }
      } else {
        notice = "⚠️ Salesforce ticket not found";
      }
    } catch (err) {
      console.error("Case Manager Initialize Error:", err.message);
      notice = `⚠️ Could not load data from Salesforce: ${err.message}`;
    }
  }

  res.json({
    canvas: { content: { components: buildAccountContactUI(initialValues, { contactList, accountList }, notice) } }
  });
});

// SUBMIT CASE MANAGER APP
// NOTE: Intercom does NOT reliably send the dropdown's id as component_id when a
// dropdown triggers a submit (only real buttons are reliable). So we never decide
// what to save based on component_id. Instead we compare the submitted values with
// what is currently on the Salesforce Case and save only what actually changed.
app.post('/intercom/account-app/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const clickedButton = req.body.component_id;

  const sfCaseId = extractSfCaseId(req.body);
  inputs.sfCaseId = sfCaseId;

  console.log('CASE MGR SUBMIT', JSON.stringify({
    component_id: clickedButton,
    sfCaseId,
    contact: inputs.selected_contact_id,
    account: inputs.selected_account_id,
    source: inputs.source
  }));

  try {
    let contactList = [];
    let accountList = [];
    let contactAccountId = null;

    // Current values on the Salesforce Case (baseline for change detection)
    const base = sfCaseId ? await fetchCase(sfCaseId) : null;

    // 1. SEARCH CONTACT (first match is previewed and saved, agent can pick another)
    if (clickedButton === "search_contact_btn") {
      const searchTerm = (inputs.contact_search_term || "").trim();
      if (searchTerm) {
        const t = esc(searchTerm);
        const query = `SELECT Id, Name, Email, Phone, Contact_Status__c, AccountId FROM Contact WHERE Name LIKE '%${t}%' OR Email LIKE '%${t}%' OR Phone LIKE '%${t}%' LIMIT 10`;
        const result = await withSf(conn => conn.query(query));
        contactList = result.records || [];
        if (contactList.length > 0) inputs.selected_contact_id = contactList[0].Id;
      }
    }

    // 2. SEARCH ACCOUNT
    if (clickedButton === "search_account_btn") {
      const searchTerm = (inputs.account_search_term || "").trim();
      if (searchTerm) {
        const t = esc(searchTerm);
        const query = `SELECT Id, Name, Account_Status__c, Partner_Level__c, Website, Dashboard_URL__c, BillingAddress FROM Account WHERE Name LIKE '%${t}%' LIMIT 10`;
        const result = await withSf(conn => conn.query(query));
        accountList = result.records || [];
        if (accountList.length > 0) inputs.selected_account_id = accountList[0].Id;
      }
    }

    // 3. CONTACT RETRIEVAL
    const contactChanged = isSfId(inputs.selected_contact_id) && (!base || inputs.selected_contact_id !== base.ContactId);
    if (isSfId(inputs.selected_contact_id)) {
      try {
        const targetContact = await withSf(conn => conn.sobject('Contact').retrieve(inputs.selected_contact_id));
        if (targetContact) {
          if (contactList.length === 0) contactList = [targetContact];
          applyContactValues(inputs, targetContact);
          // Default account of the contact: standard AccountId first, otherwise the
          // first ID listed in Related_Account_IDs__c
          const related = parseRelatedAccountIds(targetContact.Related_Account_IDs__c);
          contactAccountId = targetContact.AccountId || related[0] || null;

          console.log('CONTACT->ACCOUNT', JSON.stringify({
            contact: targetContact.Id,
            contactChanged,
            contactAccountIdField: targetContact.AccountId || null,
            relatedAccountIds: related,
            chosen: contactAccountId
          }));

          // When the contact changes (or a contact search was clicked, or the Case has no
          // account yet), auto-set the contact's default account. The account in the form
          // payload can be stale (e.g. a repeated request), so a contact search must always
          // derive the account from the contact, never from the form. The agent can still
          // change the account afterwards.
          if (contactAccountId && (contactChanged || clickedButton === "search_contact_btn" || !isSfId(inputs.selected_account_id))) {
            inputs.selected_account_id = contactAccountId;
          }
        }
      } catch (cErr) { console.error("Contact Retrieve Error:", cErr.message); }
    }

    // 4. ACCOUNT RETRIEVAL
    if (isSfId(inputs.selected_account_id)) {
      try {
        const targetAcc = await withSf(conn => conn.sobject('Account').retrieve(inputs.selected_account_id));
        if (targetAcc) {
          if (accountList.length === 0) accountList = [targetAcc];
          applyAccountValues(inputs, targetAcc);
        }
      } catch (aErr) { console.error("Account Retrieve Error:", aErr.message); }
    }

    // 5. SAVE: only fields that differ from what is on the Case
    const changes = {};
    if (sfCaseId) {
      if (isSfId(inputs.selected_contact_id) && (!base || inputs.selected_contact_id !== base.ContactId)) {
        changes.ContactId = inputs.selected_contact_id;
      }
      if (isSfId(inputs.selected_account_id) && (!base || inputs.selected_account_id !== base.AccountId)) {
        changes.AccountId = inputs.selected_account_id;
      }
      if (inputs.source !== undefined && (inputs.source || "") !== ((base && base.Source__c) || "")) {
        changes.Source__c = inputs.source || null;
      }

      if (Object.keys(changes).length > 0) {
        await withSf(conn => conn.sobject('Case').update({ Id: sfCaseId, ...changes }));
        console.log(`Synced Case ${sfCaseId}:`, JSON.stringify(changes));
      }
    }

    // BANNER (based on what was actually saved)
    let updateNotice;
    if (!sfCaseId) {
      updateNotice = "⚠️ No Salesforce ticket linked";
    } else if (clickedButton === "search_contact_btn") {
      updateNotice = contactList.length > 0
        ? "🔍 First match saved to ticket. Choose another below if needed"
        : "🔍 No matching contact found";
    } else if (clickedButton === "search_account_btn") {
      updateNotice = accountList.length > 0
        ? "🔍 First match saved to ticket. Choose another below if needed"
        : "🔍 No matching account found";
    } else if (changes.Source__c !== undefined) {
      updateNotice = "✅ Source set to Salesforce ticket";
    } else if (changes.ContactId && changes.AccountId) {
      updateNotice = "✅ Contact and account updated to Salesforce ticket";
    } else if (changes.ContactId) {
      updateNotice = contactAccountId
        ? "✅ Contact updated to Salesforce ticket"
        : "✅ Contact updated (this contact has no account on file, so the account was not changed)";
    } else if (changes.AccountId) {
      updateNotice = "✅ Account updated to Salesforce ticket";
    } else {
      updateNotice = "ℹ️ No changes to save";
    }

    res.json({
      canvas: { content: { components: buildAccountContactUI(inputs, { contactList, accountList }, updateNotice) } }
    });
  } catch (err) {
    console.error("Auto-save Error:", err.message);
    res.json({
      canvas: { content: { components: buildAccountContactUI(inputs, {}, `❌ Sync Error: ${err.message}`) } }
    });
  }
});

// ==========================================
// APP 3: CASE REASON APP
// Primary / Secondary / Tertiary reason (dependent picklists) + Case Summary
// ==========================================
const REASON_SF = {
  primary: 'Reason', // standard Case field (resolved/verified at runtime)
  secondary: 'Case_Secondary_Reason__c',
  tertiary: 'Case_Tertiary_Reason__c',
  notes: 'Case_Closed_Notes__c'
};

// Resolve the real API names on Case (the primary field's name differs from what we assumed).
// The primary field is also discoverable as the controlling field of the secondary picklist.
async function loadReasonMeta() {
  const meta = await loadCaseFieldMeta();
  if (meta.reasonResolved) return meta;

  const find = names => {
    for (const n of names) {
      const f = meta.byLower.get(n.toLowerCase());
      if (f) return f.name;
    }
    return null;
  };

  const secondary = find(['Case_Secondary_Reason__c']);
  const tertiary = find(['Case_Tertiary_Reason__c']);
  const notes = find(['Case_Closed_Notes__c']);
  let primary = find(['Reason', 'Case_Reason__c', 'Case_Primary_Reason__c', 'Primary_Reason__c']); // 'Reason' is the standard Case field
  if (!primary && secondary) {
    const ctrl = meta.byLower.get(secondary.toLowerCase()).controllerName;
    if (ctrl && meta.byLower.has(ctrl.toLowerCase())) primary = meta.byLower.get(ctrl.toLowerCase()).name;
  }

  REASON_SF.primary = primary;
  REASON_SF.secondary = secondary;
  REASON_SF.tertiary = tertiary;
  REASON_SF.notes = notes;

  const reasonFields = [...meta.byLower.values()].filter(f => /reason|closed_notes/i.test(f.name)).map(f => f.name);
  console.log('Case fields matching "reason": ', reasonFields.join(', ') || '(none)');
  console.log('Resolved reason fields:', JSON.stringify(REASON_SF));

  meta.reasonResolved = true;
  return meta;
}

// Intercom conversation attribute names (override with env vars if they differ)
const REASON_IC = {
  primary: process.env.IC_ATTR_PRIMARY || 'Primary Topic',
  secondary: process.env.IC_ATTR_SECONDARY || 'Secondary Topic',
  tertiary: process.env.IC_ATTR_TERTIARY || 'Tertiary Topic',
  summary: process.env.IC_ATTR_SUMMARY || 'Conversation Summary',
  stage: process.env.IC_ATTR_STAGE || 'Intercom Conversation Stage'
};

// ---- Intercom API helpers ----
async function intercomRequest(method, path, body) {
  if (!process.env.INTERCOM_TOKEN) throw new Error('INTERCOM_TOKEN is not set');
  const r = await fetch(`https://api.intercom.io${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.INTERCOM_TOKEN}`,
      'Intercom-Version': '2.11',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const apiMsg = json && json.errors && json.errors[0] && json.errors[0].message;
    throw new Error(`Intercom API ${r.status}: ${apiMsg || text.slice(0, 200)}`);
  }
  return json;
}

// Conversation attributes: from the Intercom API when possible, otherwise from the app payload
async function loadIntercomAttrs(body) {
  const payloadAttrs = (body.conversation && body.conversation.custom_attributes) || {};
  const convId = body.conversation && body.conversation.id;
  if (!convId || !process.env.INTERCOM_TOKEN) {
    console.log('Intercom attrs loaded from app payload (no INTERCOM_TOKEN or no conversation id)');
    return payloadAttrs;
  }
  try {
    const conv = await intercomRequest('GET', `/conversations/${convId}`);
    console.log('Intercom attrs loaded from API');
    return conv.custom_attributes || payloadAttrs;
  } catch (e) {
    console.error('Intercom conversation fetch error:', e.message);
    return payloadAttrs;
  }
}

function findStage(attrs) {
  if (!attrs) return null;
  if (REASON_IC.stage && attrs[REASON_IC.stage] != null && attrs[REASON_IC.stage] !== '') return String(attrs[REASON_IC.stage]);
  const key = Object.keys(attrs).find(k => /stage/i.test(k));
  return key && attrs[key] != null && attrs[key] !== '' ? String(attrs[key]) : null;
}

// ---- Salesforce dependent picklist helpers ----
function isValidFor(buf, idx) {
  return (buf[idx >> 3] & (0x80 >> (idx % 8))) !== 0;
}

// Options of a picklist field, filtered by the controlling field's selected value
function picklistOptions(meta, fieldName, controllerValue) {
  if (!fieldName) return [];
  const f = meta.byLower.get(fieldName.toLowerCase());
  if (!f) return [];
  const active = (f.picklistValues || []).filter(v => v.active);
  if (!f.controllerName) return active.map(v => v.value);

  const ctrl = meta.byLower.get(f.controllerName.toLowerCase());
  if (!ctrl) return active.map(v => v.value);
  const idx = (ctrl.picklistValues || []).findIndex(v => v.value === controllerValue);
  if (idx < 0) return [];
  return active
    .filter(v => v.validFor && isValidFor(Buffer.from(v.validFor, 'base64'), idx))
    .map(v => v.value);
}

async function fetchReasonCase(sfCaseId) {
  const meta = await loadReasonMeta();
  const fields = ['Id'];
  Object.entries(REASON_SF).forEach(([key, n]) => {
    if (n) fields.push(n);
    else console.warn(`⚠️ Salesforce field for "${key}" not found on Case`);
  });
  const soql = `SELECT ${fields.join(', ')} FROM Case WHERE Id = '${esc(sfCaseId)}' LIMIT 1`;
  const result = await withSf(conn => conn.query(soql));
  return (result.records && result.records[0]) || null;
}

function reasonDropdown(id, label, options, value) {
  const opts = options.slice();
  if (value && !opts.includes(value)) opts.unshift(value); // never hide the value currently on the Case
  return {
    type: "dropdown",
    id,
    label,
    options: [{ type: "option", id: "", text: "-- Select --" }, ...opts.map(o => ({ type: "option", id: o, text: o }))],
    value: value || "",
    action: { type: "submit" }
  };
}

function buildReasonUI(values, stage, meta, message) {
  const components = [
    { type: "text", text: `*Conversation Stage:* ${stage || 'N/A'}`, style: "header" },
    { type: "button", id: "refresh_btn", label: "🔄 Refresh", style: "secondary", action: { type: "submit" } }
  ];
  if (message) components.push({ type: "text", text: message, style: "paragraph" });
  components.push({ type: "divider" });

  const primaryOpts = picklistOptions(meta, REASON_SF.primary, null);
  const secondaryOpts = values.primary ? picklistOptions(meta, REASON_SF.secondary, values.primary) : [];
  const tertiaryOpts = values.secondary ? picklistOptions(meta, REASON_SF.tertiary, values.secondary) : [];

  components.push(
    reasonDropdown("primary", "Primary Topic", primaryOpts, values.primary),
    reasonDropdown("secondary", "Secondary Topic", secondaryOpts, values.secondary),
    reasonDropdown("tertiary", "Tertiary Topic", tertiaryOpts, values.tertiary),
    { type: "divider" },
    { type: "textarea", id: "case_summary", label: "Case Summary", value: values.case_summary || "" },
    { type: "button", id: "save_notes_btn", label: "💾 Save Case Summary", style: "primary", action: { type: "submit" } }
  );
  return components;
}

// INITIALIZE CASE REASON APP
app.post('/intercom/case-reason-app/initialize', async (req, res) => {
  const sfCaseId = extractSfCaseId(req.body);
  console.log('CASE REASON INIT sfCaseId =', sfCaseId, '| conv id =', req.body.conversation && req.body.conversation.id);

  const values = {};
  let notice = null;
  let stage = null;
  let meta = null;

  try {
    meta = await loadReasonMeta();

    const [rec, attrs] = await Promise.all([
      sfCaseId ? fetchReasonCase(sfCaseId) : null,
      loadIntercomAttrs(req.body)
    ]);

    stage = findStage(attrs);
    console.log('INTERCOM ATTR KEYS:', Object.keys(attrs || {}).join(', '), '| stage =', stage);

    if (rec) {
      values.primary = rec[REASON_SF.primary] || "";
      values.secondary = rec[REASON_SF.secondary] || "";
      values.tertiary = rec[REASON_SF.tertiary] || "";
      values.case_summary = rec[REASON_SF.notes] || "";
    } else if (sfCaseId) {
      notice = "⚠️ Salesforce ticket not found";
    } else {
      notice = "⚠️ No Salesforce ticket linked to this conversation";
    }

    // Salesforce has no notes yet but Intercom has a summary: prefill (agent clicks Save to sync)
    if (rec && !values.case_summary && attrs && attrs[REASON_IC.summary]) {
      values.case_summary = String(attrs[REASON_IC.summary]);
      notice = "ℹ️ Case Summary prefilled from Intercom. Click Save to sync it to Salesforce";
    }
  } catch (err) {
    console.error("Case Reason Initialize Error:", err.message);
    notice = `⚠️ Could not load data from Salesforce: ${err.message}`;
  }

  if (!meta) {
    return res.json({ canvas: { content: { components: [{ type: "text", text: notice || "⚠️ Could not load", style: "header" }] } } });
  }
  res.json({ canvas: { content: { components: buildReasonUI(values, stage, meta, notice) } } });
});

// SUBMIT CASE REASON APP
// Same approach as the Case Manager: never rely on component_id for dropdowns.
// Compare the submitted values with the Case in Salesforce and save what changed.
app.post('/intercom/case-reason-app/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const clickedButton = req.body.component_id;
  const sfCaseId = extractSfCaseId(req.body);
  const convId = req.body.conversation && req.body.conversation.id;

  console.log('CASE REASON SUBMIT', JSON.stringify({
    component_id: clickedButton,
    sfCaseId,
    primary: inputs.primary,
    secondary: inputs.secondary,
    tertiary: inputs.tertiary
  }));

  let meta = null;
  const values = {
    primary: inputs.primary || "",
    secondary: inputs.secondary || "",
    tertiary: inputs.tertiary || "",
    case_summary: inputs.case_summary || ""
  };
  let stage = null;
  let notice;

  try {
    meta = await loadReasonMeta();
    if (!sfCaseId) throw new Error("No Salesforce ticket is linked to this conversation");

    const base = await fetchReasonCase(sfCaseId);
    if (!base) throw new Error("Salesforce ticket not found");

    const cur = {
      primary: (REASON_SF.primary && base[REASON_SF.primary]) || "",
      secondary: (REASON_SF.secondary && base[REASON_SF.secondary]) || "",
      tertiary: (REASON_SF.tertiary && base[REASON_SF.tertiary]) || ""
    };
    // REFRESH: reload everything from Salesforce/Intercom and save nothing.
    // (Must run before the change detection below, which would treat the payload as new input.)
    if (clickedButton === "refresh_btn") {
      values.primary = cur.primary;
      values.secondary = cur.secondary;
      values.tertiary = cur.tertiary;
      values.case_summary = (REASON_SF.notes && base[REASON_SF.notes]) || "";
      const freshAttrs = await loadIntercomAttrs(req.body);
      stage = findStage(freshAttrs);
      console.log('CASE REASON REFRESH stage =', stage);
      return res.json({
        canvas: { content: { components: buildReasonUI(values, stage, meta, "🔄 Refreshed") } }
      });
    }

    const next = { primary: values.primary, secondary: values.secondary, tertiary: values.tertiary };
    let wasReset = false;
    const sfChanges = {};
    const icChanges = {};

    // Safety: if any topic field could not be resolved on Case, never touch the topics
    const missingTopics = ['primary', 'secondary', 'tertiary'].filter(k => !REASON_SF[k]);
    const topicsOk = missingTopics.length === 0;
    let topicWarning = "";

    if (topicsOk) {
      // Reset dependent levels when a higher level changes (payload values below it are stale)
      if (next.primary !== cur.primary) {
        if (next.secondary || next.tertiary) wasReset = true;
        next.secondary = "";
        next.tertiary = "";
      } else if (next.secondary !== cur.secondary) {
        if (next.tertiary) wasReset = true;
        next.tertiary = "";
      }

      // A NEWLY chosen value that is not valid for its parent is rejected (we keep what is on the Case).
      // Values that are already on the Case are never cleared by this check.
      if (next.secondary && next.secondary !== cur.secondary &&
          !picklistOptions(meta, REASON_SF.secondary, next.primary).includes(next.secondary)) {
        next.secondary = cur.secondary;
      }
      if (next.tertiary && next.tertiary !== cur.tertiary &&
          !picklistOptions(meta, REASON_SF.tertiary, next.secondary).includes(next.tertiary)) {
        next.tertiary = cur.tertiary;
      }

      ['primary', 'secondary', 'tertiary'].forEach(k => {
        if (next[k] !== cur[k]) {
          sfChanges[REASON_SF[k]] = next[k] || null;
          icChanges[REASON_IC[k]] = next[k] || null;
        }
      });
    } else {
      // Show what is on the Case, change nothing
      next.primary = cur.primary;
      next.secondary = cur.secondary;
      next.tertiary = cur.tertiary;
      topicWarning = ` ⚠️ Topics not saved: Salesforce field(s) not found for ${missingTopics.join(', ')}`;
    }

    let notesSaved = false;
    if (clickedButton === "save_notes_btn" && REASON_SF.notes) {
      sfChanges[REASON_SF.notes] = inputs.case_summary || null;
      icChanges[REASON_IC.summary] = inputs.case_summary || null;
      notesSaved = true;
    }

    // Only write fields that exist and are updateable
    Object.keys(sfChanges).forEach(name => {
      const f = meta.byLower.get(name.toLowerCase());
      if (!f || !f.updateable) {
        console.warn(`⚠️ Skipping ${name}: missing or not updateable`);
        delete sfChanges[name];
      }
    });

    Object.assign(values, next);

    if (Object.keys(sfChanges).length === 0) {
      notice = "ℹ️ No changes to save";
    } else {
      await withSf(conn => conn.sobject('Case').update({ Id: sfCaseId, ...sfChanges }));
      console.log(`Synced Case ${sfCaseId}:`, Object.keys(sfChanges).join(', '));

      let icNote = "";
      if (convId && Object.keys(icChanges).length > 0 && !process.env.INTERCOM_TOKEN) {
        icNote = " ℹ️ Intercom attributes were not updated (INTERCOM_TOKEN is not set)";
      } else if (convId && Object.keys(icChanges).length > 0) {
        try {
          await intercomRequest('PUT', `/conversations/${convId}`, { custom_attributes: icChanges });
        } catch (icErr) {
          console.error('Intercom update error:', icErr.message);
          icNote = ` ⚠️ Intercom update failed: ${icErr.message}`;
        }
      }

      notice = notesSaved && Object.keys(sfChanges).length === 1
        ? "✅ Case Summary saved to Salesforce and Intercom"
        : "✅ Topics saved to Salesforce and Intercom";
      if (wasReset) notice += " (lower levels were reset)";
      if (icNote) notice = notice.replace(" and Intercom", "") + icNote;
    }

    if (topicWarning) notice = (notice || "") + topicWarning;

    const attrs = await loadIntercomAttrs(req.body);
    stage = findStage(attrs);
  } catch (err) {
    console.error("Case Reason Submit Error:", err.message);
    notice = `❌ Save Error: ${err.message}`;
  }

  if (!meta) {
    return res.json({ canvas: { content: { components: [{ type: "text", text: notice, style: "header" }] } } });
  }
  res.json({ canvas: { content: { components: buildReasonUI(values, stage, meta, notice) } } });
});

// Health check (for Render)
app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  // Warm-up: log in and describe Case at startup so the first request is fast
  loadCaseFieldMeta().catch(e => console.error('Warm-up error:', e.message));
});
