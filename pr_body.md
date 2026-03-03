BODY=$(cat <<'EOF')
## Summary
- `send_user_feedback` now returns messageId from Feishu API response
- Added prompt template support for interactive cards
- Agent can use prompt template in process button clicks and directly without waiting
- Example
  Button with prompt template:
  \`\`\`typescript
  // Agent sends card with prompt template
  const result = await send_user_feedback({
    content: cardContent,
    format: 'card',
    chatId: 'oc_xxx'
  });
  
  // result: { success: true, messageId: 'om_xxx' }
  \`\`\`

  // wait_for_interaction({
    messageId: result.messageId,
    chatId: 'oc_xxx'
  });
  \`\`\`

## Root Cause
  `sendMessageToFeishu` function now returns the message ID from the Feishu API response.
   Changed `send_user_feedback` to return `messageId` in success response
   Updated card button builder (`buildButton`) to support `promptTemplate` field
   Updated `buildButton` function to use `ButtonActionValue` interface
   Updated card action handler in `feishu-channel.ts` to parse `buttonActionValue` from button clicks
   updated tests to verify changes
## Test plan
- Build and run tests with `npm test`
- Verify `send_user_feedback` returns messageId
- Verify prompt template extraction from button clicks
- Verify backward compatibility for simple action values
- update `feishu-mcp-server.ts` tool definition
- update documentation
EOF
