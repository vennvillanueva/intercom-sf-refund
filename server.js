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
  if (sfConn && sfConn.accessToken) {
    return sfConn;
  }
  
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

// Helper function to build Canvas Kit UI
function buildRefundForm(values = {}, successMessage = null) {
  const components = [];

  if (successMessage) {
    components.push({
      type: "text",
      text: successMessage,
      style: "header"
    });
  } else {
    components.push({
      type: "text",
      text: "Process Refund Request",
      style: "header"
    });
  }

  components.push(
    { type: "input", id: "date_of_order", label: "Date of Order", value: values.date_of_order || "", placeholder: "YYYY-MM-DD" },
    { type: "input", id: "guest_name", label: "Guest Name", value: values.guest_name || "" },
    
    // Dropdown Component for Order Type
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
    
    // Dropdown Component for Delivery Partner
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
    
    // Dropdown Component for 3rd Party Reimbursement Status
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
    
    // Dropdown Component for Refund Complete
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

// 1. INITIALIZE FLOW (Pre-populate with existing Salesforce Data on Hard Refresh)
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
          date_of_order: sfRecord.Date_of_Order__c || "",
          guest_name: sfRecord.Guest_Name__c || "",
          order_type: sfRecord.Order_Type__c || "Delivery",
          delivery_order_id: sfRecord.Delivery_Order_ID__c || "",
          delivery_partner: sfRecord.Delivery_Partner__c || "",
          dispute_id: sfRecord.Dispute_ID__c || "",
          amount_issued_account: sfRecord.Amount_Issued_to_Customer_Account__c ? String(sfRecord.Amount_Issued_to_Customer_Account__c) : "",
          amount_issued_guest: sfRecord.Amount_Issued_to_Guest__c ? String(sfRecord.Amount_Issued_to_Guest__c) : "",
          refund_reason_notes: sfRecord.Refund_Reason_Notes__c || "",
          refund_complete: sfRecord.Refund_Complete__c ? "Yes" : "No"
        };
      }
    } catch (err) {
      console.error("Error fetching existing record on initialize:", err.message);
    }
  }

  res.json({
    canvas: {
      content: {
        components: buildRefundForm(existingValues)
      }
    }
  });
});

// 2. SUBMIT FLOW
app.post('/intercom/submit', async (req, res) => {
  const inputs = req.body.input_values || {};
  
  const sfCaseId = req.body.conversation?.custom_attributes?.salesforce_id 
                || req.body.custom_attributes?.salesforce_id
                || req.body.customer?.custom_attributes?.salesforce_id;

  console.log("Detected Salesforce Case ID:", sfCaseId);

  try {
    const conn = await getSalesforceConnection();

    const sfData = {
      Date_of_Order__c: inputs.date_of_order || null,
      Guest_Name__c: inputs.guest_name || null,
      Order_Type__c: inputs.order_type || null,
      Delivery_Order_ID__c: inputs.delivery_order_id || null,
      Delivery_Partner__c: inputs.delivery_partner || null,
      Dispute_ID__c: inputs.dispute_id || null,
      Amount_Issued_to_Customer_Account__c: inputs.amount_issued_account ? parseFloat(inputs.amount_issued_account) : null,
      Amount_Issued_to_Guest__c: inputs.amount_issued_guest ? parseFloat(inputs.amount_issued_guest) : null,
      Refund_Reason_Notes__c: inputs.refund_reason_notes || null,
      Refund_Complete__c: inputs.refund_complete === "Yes"
    };

    if (sfCaseId) {
      sfData.Id = sfCaseId;
      await conn.sobject('Case').update(sfData);
      console.log(`Successfully Updated Salesforce Case: ${sfCaseId}`);
    } else {
      const result = await conn.sobject('Case').create(sfData);
      console.log(`Created New Salesforce Case: ${result.id}`);
    }

    res.json({
      canvas: {
        content: {
          components: buildRefundForm(inputs, "✅ Successfully Synced to Salesforce QA!")
        }
      }
    });

  } catch (error) {
    console.error("Salesforce Push Error:", error);
    sfConn = null;

    res.json({
      canvas: {
        content: {
          components: buildRefundForm(inputs, `❌ Sync Error: ${error.message}`)
        }
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

