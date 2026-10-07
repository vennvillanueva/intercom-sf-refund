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
  if (sfConn && sfConn.accessToken) return sfConn;
  
  sfConn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL || 'https://ownercom--qa.sandbox.my.salesforce.com',
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
  const sfCaseId = req.body.conversation?.custom_attributes?.salesforce_id 
                || req.body.custom_attributes?.salesforce_id
                || req.body.customer?.custom_attributes?.salesforce_id;
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
    } catch (err) { console.error(err.message); }
  }
  res.json({ canvas: { content: { components: buildRefundForm(existingValues) } } });
});

app.post('/intercom/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const sfCaseId = req.body.conversation?.custom_attributes?.salesforce_id 
                || req.body.custom_attributes?.salesforce_id
                || req.body.customer?.custom_attributes?.salesforce_id;
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
// APP 2: SALESFORCE CASE MANAGER (No Header inside Canvas)
// ==========================================
function buildAccountContactUI(values = {}, options = {}) {
  const components = [];

  // Contact Search Block (Directly starts here)
  components.push(
    { type: "input", id: "contact_search_term", label: "Search Contact", value: values.contact_search_term || "", placeholder: "Type contact name..." },
    { type: "button", id: "search_contact_btn", label: "🔍 Search Contact", style: "primary", action: { type: "submit" } }
  );

  if (options.contactList && options.contactList.length > 0) {
    const contactDropdown = options.contactList.map(c => ({
      type: "option",
      id: c.Id,
      text: `${c.Name} (${c.Email || 'No Email'})`
    }));
    components.push({
      type: "dropdown",
      id: "selected_contact_id",
      label: "Select Matching Contact",
      options: contactDropdown,
      value: values.selected_contact_id || contactDropdown[0].id
    });
  }

  components.push({ type: "text", text: `*Contact Status:* ${values.contact_status || 'N/A'}`, style: "paragraph" });
  components.push({ type: "divider" });

  // Account Search Block
  components.push(
    { type: "input", id: "account_search_term", label: "Search Account", value: values.account_search_term || "", placeholder: "Type account name..." },
    { type: "button", id: "search_account_btn", label: "🔍 Search Account", style: "primary", action: { type: "submit" } }
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

  // Read-only Account Data Display
  components.push(
    { type: "text", text: `*Account Status:* ${values.account_status || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Partner Level:* ${values.partner_level || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Website:* ${values.website || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Dashboard URL:* ${values.dashboard_url || 'N/A'}`, style: "paragraph" },
    { type: "text", text: `*Billing Address:* ${values.billing_address || 'N/A'}`, style: "paragraph" }
  );

  return components;
}

app.post('/intercom/account-app/initialize', async (req, res) => {
  const sfAccountId = req.body.conversation?.custom_attributes?.salesforce_account_id 
                   || req.body.custom_attributes?.salesforce_account_id
                   || req.body.customer?.custom_attributes?.salesforce_account_id;
  let initialValues = {};
  if (sfAccountId) {
    try {
      const conn = await getSalesforceConnection();
      const sfAccount = await conn.sobject('Account').retrieve(sfAccountId);
      if (sfAccount) {
        initialValues = {
          account_search_term: sfAccount.Name || "",
          account_status: sfAccount.Account_Status__c || "N/A",
          partner_level: sfAccount.Partner_Level__c || "N/A",
          website: sfAccount.Website || "N/A",
          dashboard_url: sfAccount.Dashboard_URL__c || "N/A",
          billing_address: formatAddress(sfAccount.BillingAddress)
        };
      }
    } catch (err) { console.error(err.message); }
  }
  res.json({ canvas: { content: { components: buildAccountContactUI(initialValues) } } });
});

app.post('/intercom/account-app/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  const clickedButton = req.body.component_id;
  try {
    const conn = await getSalesforceConnection();

    if (clickedButton === "search_contact_btn") {
      const searchTerm = (inputs.contact_search_term || "").trim();
      let contactList = [];
      if (searchTerm) {
        const query = `SELECT Id, Name, Contact_Status__c FROM Contact WHERE Name LIKE '%${searchTerm}%' LIMIT 10`;
        const result = await conn.query(query);
        contactList = result.records || [];
        if (contactList.length > 0) {
          inputs.contact_status = contactList[0].Contact_Status__c || "N/A";
        }
      }
      return res.json({ canvas: { content: { components: buildAccountContactUI(inputs, { contactList }) } } });
    }

    if (clickedButton === "search_account_btn") {
      const searchTerm = (inputs.account_search_term || "").trim();
      let accountList = [];
      if (searchTerm) {
        const query = `SELECT Id, Name, Account_Status__c, Partner_Level__c, Website, Dashboard_URL__c, BillingAddress FROM Account WHERE Name LIKE '%${searchTerm}%' LIMIT 10`;
        const result = await conn.query(query);
        accountList = result.records || [];
        if (accountList.length > 0) {
          const topAcc = accountList[0];
          inputs.account_status = topAcc.Account_Status__c || "N/A";
          inputs.partner_level = topAcc.Partner_Level__c || "N/A";
          inputs.website = topAcc.Website || "N/A";
          inputs.dashboard_url = topAcc.Dashboard_URL__c || "N/A";
          inputs.billing_address = formatAddress(topAcc.BillingAddress);
        }
      }
      return res.json({ canvas: { content: { components: buildAccountContactUI(inputs, { accountList }) } } });
    }

    res.json({ canvas: { content: { components: buildAccountContactUI(inputs) } } });
  } catch (err) {
    res.json({ canvas: { content: { components: buildAccountContactUI(inputs) } } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
