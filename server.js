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

async function loadCaseFieldMeta() {
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
          contactAccountId = targetContact.AccountId || null;

          // When the contact changes, auto-set the contact's account (agent can still change it)
          if (contactChanged && contactAccountId) {
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
    } else if (changes.ContactId) {
      updateNotice = "✅ Contact updated to Salesforce ticket";
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

// Health check (for Render)
app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  // Warm-up: log in and describe Case at startup so the first request is fast
  loadCaseFieldMeta().catch(e => console.error('Warm-up error:', e.message));
});
