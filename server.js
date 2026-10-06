require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

// Helper function to build Canvas Kit components
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
    { type: "input", id: "order_type", label: "Order Type", value: values.order_type || "" },
    { type: "input", id: "delivery_order_id", label: "Delivery Order ID", value: values.delivery_order_id || "" },
    { type: "input", id: "delivery_partner", label: "Delivery Partner", value: values.delivery_partner || "" },
    { type: "input", id: "dispute_id", label: "Dispute ID", value: values.dispute_id || "" },
    { type: "input", id: "amount_issued_account", label: "Amount Issued to Customer (Account)", value: values.amount_issued_account || "" },
    { type: "input", id: "amount_issued_guest", label: "Amount Issued to Guest", value: values.amount_issued_guest || "" },
    { type: "textarea", id: "refund_reason_notes", label: "Refund Reason Notes", value: values.refund_reason_notes || "" },
    { type: "input", id: "third_party_reimbursement_amount", label: "3rd Party Reimbursement Amount", value: values.third_party_reimbursement_amount || "" },
    { type: "input", id: "third_party_reimbursement_status", label: "3rd Party Reimbursement Status", value: values.third_party_reimbursement_status || "" },
    { type: "input", id: "stripe_reimbursement_link", label: "Stripe Reimbursement Link", value: values.stripe_reimbursement_link || "" },
    
    // Clean & Standard Checkbox Component
    {
      type: "checkbox",
      id: "refund_complete",
      label: "Refund Complete",
      value: values.refund_complete === "true" || values.refund_complete === true
    },

    { type: "button", id: "submit_refund", label: "Update Salesforce Ticket", style: "primary", action: { type: "submit" } }
  );

  return components;
}

app.post('/intercom/initialize', (req, res) => {
  res.json({
    canvas: {
      content: {
        components: buildRefundForm()
      }
    }
  });
});

app.post('/intercom/submit', async (req, res) => {
  const inputs = req.body.input_values || {};

  res.json({
    canvas: {
      content: {
        components: buildRefundForm(inputs, "✅ Successfully Updated in Salesforce!")
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

