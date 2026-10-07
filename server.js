require('dotenv').config();
const express = require('express');
const jsforce = require('jsforce');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

// Reusable JSForce Connection
let sfConn = null;

async function getSalesforceConnection() {
  if (sfConn && sfConn.accessToken && sfConn.instanceUrl) {
    return sfConn;
  }
  
  const loginUrl = process.env.SF_LOGIN_URL || 'https://ownercom--qa.sandbox.my.salesforce.com';
  
  sfConn = new jsforce.Connection({
    loginUrl: loginUrl.startsWith('http') ? loginUrl : `https://${loginUrl}`,
    version: '57.0'
  });

  await sfConn.login(
    process.env.SF_USERNAME,
    process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
  );

  return sfConn;
}

function formatAddress(addr) {
  if (!addr) return "N/A";
  if (typeof addr === 'string') return addr;
  const parts = [addr.street, addr.city, addr.state, addr.postalCode, addr.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : "N/A";
}

// Helper: Extract Salesforce Case ID from all possible Intercom payload paths
function extractSfCaseId(body) {
  return body.conversation?.custom_attributes?.salesforce_id
      || body.conversation?.custom_attributes?.salesforce_case_id
      || body.conversation?.custom_attributes?.sf_case_id
      || body.custom_attributes?.salesforce_id
      || body.custom_attributes?.salesforce_case_id
      || body.customer?.custom_attributes?.salesforce_id
      || body.customer?.custom_attributes?.salesforce_case_id
      || body.user?.custom_attributes?.salesforce_id
      || body.user?.custom_attributes?.salesforce_case_id;
}

// ==========================================
// APP 1: REFUND APP (Form & Endpoints)
// ==========================================
function buildRefundForm(values = {}) {
  return [
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
  ];
}

app.post('/intercom/initialize', async (req, res) => {
  const sfCaseId = extractSfCaseId(req.body);
  let existingValues = {};
  if (sfCaseId) {
    try {
      const conn = await getSalesforceConnection();
      const sfRecord = await conn.sobject('Case').retrieve(sfCaseId);
      if (sfRecord) {
        existingValues = {
          order_id: sfRecord.Order_ID__c || "",
          date_of_order: sfRecord.Date_of_Order__c || "",
          guest_name: sfRecord.Guest_Name__c || "",
          order_type: sfRecord.Order_Type__c || "Delivery",
          delivery_order_id: sfRecord.Delivery_Order_ID__c || "",
          delivery_partner: sfRecord.Delivery_Partner__c || "",
          dispute_id: sfRecord.Dispute_ID__c || "",
          amount_issued_account: sfRecord.Amount_Issued_to_Customer_Account__c ? String(sfRecord.Amount_Issued_to_Customer_Account__c) : "",
          amount_issued_guest: sfRecord.Amount_Issued_to_Guest__c ? String(sfRecord.Amount_Issued_to_Guest__c) : "",
          refund_reason_notes: sfRecord.Refund_Reason_Notes__c || "",
          third_party_reimbursement_amount: sfRecord.Third_Party_Reimbursement_Amount__c ? String(sfRecord.Third_Party_Reimbursement_Amount__c) : "",
          third_party_reimbursement_status: sfRecord.Third_Party_Reimbursement_Status__c || "",
          stripe_reimbursement_link: sfRecord.Stripe_Reimbursement_Link__c || "",
          refund_complete: sfRecord.Refund_Complete__c ? "Yes" : "No"
        };
      }
    } catch (err) { console.error("Initialize Case Fetch Error:", err.message); }
  }
  res.json({ canvas: { content: { components: buildRefundForm(existingValues) } } });
});

app.post('/intercom/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const sfCaseId = extractSfCaseId(req.body);
  try {
    const conn = await getSalesforceConnection();
    const sfData = {
      Order_ID__c: inputs.order_id || null,
      Date_of_Order__c: inputs.date_of_order || null,
      Guest_Name__c: inputs.guest_name || null,
      Order_Type__c: inputs.order_type || null,
      Delivery_Order_ID__c: inputs.delivery_order_id || null,
      Delivery_Partner__c: inputs.delivery_partner || null,
      Dispute_ID__c: inputs.dispute_id || null,
      Amount_Issued_to_Customer_Account__c: inputs.amount_issued_account ? parseFloat(inputs.amount_issued_account) : null,
      Amount_Issued_to_Guest__c: inputs.amount_issued_guest ? parseFloat(inputs.amount_issued_guest) : null,
      Refund_Reason_Notes__c: inputs.refund_reason_notes || null,
      Third_Party_Reimbursement_Amount__c: inputs.third_party_reimbursement_amount ? parseFloat(inputs.third_party_reimbursement_amount) : null,
      Third_Party_Reimbursement_Status__c: inputs.third_party_reimbursement_status || null,
      Stripe_Reimbursement_Link__c: inputs.stripe_reimbursement_link || null,
      Refund_Complete__c: inputs.refund_complete === "Yes"
    };
    if (sfCaseId) {
      sfData.Id = sfCaseId;
      await conn.sobject('Case').update(sfData);
    } else {
      await conn.sobject('Case').create(sfData);
    }
    res.json({ canvas: { content: { components: buildRefundForm(inputs) } } });
  } catch (error) {
    sfConn = null;
    res.json({ canvas: { content: { components: buildRefundForm(inputs) } } });
  }
});


// ==========================================
// APP 2: SALESFORCE CASE MANAGER
// ==========================================
function buildAccountContactUI(values = {}, options = {}, message = null) {
  const components = [];

  if (message) {
    components.push({
      type: "text",
      text: message,
      style: "header"
    });
  }

  // 1. GO TO SALESFORCE TICKET BUTTON
  if (values.sfCaseId) {
    const sfDomain = process.env.SF_LOGIN_URL || 'https://ownercom--qa.sandbox.my.salesforce.com';
    const caseUrl = `${sfDomain}/${values.sfCaseId}`;
    components.push(
      {
        type: "button",
        id: "open_sf_ticket_btn",
        label: "🔗 Go to Salesforce Ticket",
        style: "primary",
        action: {
          type: "url",
          url: caseUrl
        }
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
      value: values.selected_contact_id || contactDropdown[0].id
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
      value: values.selected_account_id || accountDropdown[0].id
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

  // 4. SOURCE DROPDOWN FIELD WITH AUTO-SUBMIT ACTION
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

// INITIALIZE FLOW (Robust Search across all possible Salesforce Case ID locations)
app.post('/intercom/account-app/initialize', async (req, res) => {
  const sfCaseId = extractSfCaseId(req.body);

  let initialValues = { sfCaseId };
  let contactList = [];
  let accountList = [];

  if (sfCaseId) {
    try {
      const conn = await getSalesforceConnection();
      const sfCase = await conn.sobject('Case').retrieve(sfCaseId);

      if (sfCase) {
        initialValues.source = sfCase.Source__c || "";
        initialValues.selected_contact_id = sfCase.ContactId || "";
        initialValues.selected_account_id = sfCase.AccountId || "";

        const fetchPromises = [];

        if (sfCase.ContactId) {
          fetchPromises.push(
            conn.sobject('Contact').retrieve(sfCase.ContactId)
              .then(c => {
                if (c) {
                  contactList = [c];
                  initialValues.contact_search_term = c.Name || "";
                  initialValues.contact_email = c.Email || "N/A";
                  initialValues.contact_phone = c.Phone || "N/A";
                  initialValues.contact_status = c.Contact_Status__c || "N/A";
                }
              }).catch(e => console.error("Init Contact Error:", e.message))
          );
        }

        if (sfCase.AccountId) {
          fetchPromises.push(
            conn.sobject('Account').retrieve(sfCase.AccountId)
              .then(a => {
                if (a) {
                  accountList = [a];
                  initialValues.account_search_term = a.Name || "";
                  initialValues.account_status = a.Account_Status__c || "N/A";
                  initialValues.partner_level = a.Partner_Level__c || "N/A";
                  initialValues.website = a.Website || "N/A";
                  initialValues.dashboard_url = a.Dashboard_URL__c || "N/A";
                  initialValues.billing_address = formatAddress(a.BillingAddress);
                }
              }).catch(e => console.error("Init Account Error:", e.message))
          );
        }

        await Promise.all(fetchPromises);
      }
    } catch (err) { console.error("Case Manager Initialize Error:", err.message); }
  }

  res.json({
    canvas: {
      content: {
        components: buildAccountContactUI(initialValues, { contactList, accountList })
      }
    }
  });
});

app.post('/intercom/account-app/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const clickedButton = req.body.component_id;

  const sfCaseId = extractSfCaseId(req.body);
  inputs.sfCaseId = sfCaseId;

  try {
    const conn = await getSalesforceConnection();

    let contactList = [];
    let accountList = [];

    // 1. ACTION: SEARCH CONTACT BUTTON CLICKED
    if (clickedButton === "search_contact_btn") {
      const searchTerm = (inputs.contact_search_term || "").trim();
      if (searchTerm) {
        const query = `SELECT Id, Name, Email, Phone, Contact_Status__c, AccountId FROM Contact WHERE Name LIKE '%${searchTerm}%' OR Email LIKE '%${searchTerm}%' OR Phone LIKE '%${searchTerm}%' LIMIT 10`;
        const result = await conn.query(query);
        contactList = result.records || [];
        if (contactList.length > 0) {
          inputs.selected_contact_id = contactList[0].Id;
        }
      }
    }

    // 2. ACTION: SEARCH ACCOUNT BUTTON CLICKED
    if (clickedButton === "search_account_btn") {
      const searchTerm = (inputs.account_search_term || "").trim();
      if (searchTerm) {
        const query = `SELECT Id, Name, Account_Status__c, Partner_Level__c, Website, Dashboard_URL__c, BillingAddress FROM Account WHERE Name LIKE '%${searchTerm}%' LIMIT 10`;
        const result = await conn.query(query);
        accountList = result.records || [];
        if (accountList.length > 0) {
          inputs.selected_account_id = accountList[0].Id;
        }
      }
    }

    // 3. INDEPENDENT CONTACT RETRIEVAL
    if (inputs.selected_contact_id) {
      try {
        const targetContact = await conn.sobject('Contact').retrieve(inputs.selected_contact_id);
        if (targetContact) {
          if (contactList.length === 0) contactList = [targetContact];
          inputs.contact_email = targetContact.Email || "N/A";
          inputs.contact_phone = targetContact.Phone || "N/A";
          inputs.contact_status = targetContact.Contact_Status__c || "N/A";

          if (clickedButton === "search_contact_btn" && targetContact.AccountId) {
            inputs.selected_account_id = targetContact.AccountId;
          }
        }
      } catch (cErr) { console.error("Contact Retrieve Error:", cErr.message); }
    }

    // 4. INDEPENDENT ACCOUNT RETRIEVAL
    if (inputs.selected_account_id) {
      try {
        const targetAcc = await conn.sobject('Account').retrieve(inputs.selected_account_id);
        if (targetAcc) {
          if (accountList.length === 0) accountList = [targetAcc];
          inputs.account_search_term = targetAcc.Name;
          inputs.account_status = targetAcc.Account_Status__c || "N/A";
          inputs.partner_level = targetAcc.Partner_Level__c || "N/A";
          inputs.website = targetAcc.Website || "N/A";
          inputs.dashboard_url = targetAcc.Dashboard_URL__c || "N/A";
          inputs.billing_address = formatAddress(targetAcc.BillingAddress);
        }
      } catch (aErr) { console.error("Account Retrieve Error:", aErr.message); }
    }

    // STRICT DETERMINATION OF UPDATE NOTICE BANNER
    let updateNotice = "✅ Salesforce ticket updated";

    if (clickedButton === "source" || (inputs.source && !clickedButton)) {
      updateNotice = "✅ Source set to Salesforce ticket";
    } else if (clickedButton === "selected_contact_id" || clickedButton === "search_contact_btn") {
      updateNotice = "✅ Contact updated to Salesforce ticket";
    } else if (clickedButton === "selected_account_id" || clickedButton === "search_account_btn") {
      updateNotice = "✅ Account updated to Salesforce ticket";
    }

    // UPDATE Source__c DIRECTLY TO SALESFORCE CASE
    if (sfCaseId) {
      const sfData = {
        Id: sfCaseId,
        ContactId: inputs.selected_contact_id || null,
        AccountId: inputs.selected_account_id || null
      };

      if (inputs.source !== undefined) {
        sfData.Source__c = inputs.source;
      }

      await conn.sobject('Case').update(sfData);
      console.log(`Auto-synced Case ${sfCaseId} with Source: ${inputs.source}`);
    }

    res.json({
      canvas: {
        content: {
          components: buildAccountContactUI(inputs, { contactList, accountList }, updateNotice)
        }
      }
    });

  } catch (err) {
    console.error("Auto-save Error:", err.message);
    sfConn = null;
    res.json({
      canvas: {
        content: {
          components: buildAccountContactUI(inputs, {}, `❌ Sync Error: ${err.message}`)
        }
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
