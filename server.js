require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

app.post('/intercom/initialize', (req, res) => {
  res.json({
    canvas: {
      content: {
        components: [
          { type: "text", text: "Process Refund Request", style: "header" },
          
          { type: "input", id: "date_of_order", label: "Date of Order", placeholder: "YYYY-MM-DD" },
          { type: "input", id: "guest_name", label: "Guest Name" },
          { type: "input", id: "order_type", label: "Order Type" },
          { type: "input", id: "delivery_order_id", label: "Delivery Order ID" },
          { type: "input", id: "delivery_partner", label: "Delivery Partner" },
          { type: "input", id: "dispute_id", label: "Dispute ID" },
          { type: "input", id: "amount_issued_account", label: "Amount Issued to Customer (Account)" },
          { type: "input", id: "amount_issued_guest", label: "Amount Issued to Guest" },
          { type: "textarea", id: "refund_reason_notes", label: "Refund Reason Notes" },
          { type: "input", id: "third_party_reimbursement_amount", label: "3rd Party Reimbursement Amount" },
          { type: "input", id: "third_party_reimbursement_status", label: "3rd Party Reimbursement Status" },
          { type: "input", id: "stripe_reimbursement_link", label: "Stripe Reimbursement Link" },
          
          { type: "button", id: "submit_refund", label: "Update Salesforce Ticket", style: "primary", action: { type: "submit" } }
        ]
      }
    }
  });
});

app.post('/intercom/submit', (req, res) => {
  const inputs = req.body.input_values || {};
  res.json({
    canvas: {
      content: {
        components: [
          { type: "text", text: "✅ Successfully Submitted!", style: "header" },
          { type: "text", text: `Guest: ${inputs.guest_name || 'N/A'}` }
        ]
      }
    }
  });
});

app.listen(3000, () => console.log('Local Server is running on port 3000!'));
