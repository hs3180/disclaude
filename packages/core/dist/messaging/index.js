/**
 * Messaging types module.
 *
 * Re-exports Universal Message Format types for use by other packages.
 */
export { 
// Type Guards
isTextContent, isMarkdownContent, isCardContent, isFileContent, isDoneContent, 
// Helpers
createTextMessage, createMarkdownMessage, createCardMessage, createDoneMessage, } from './universal-message.js';
// Input MessageRouter (Issue #3580: RFC #3329 Phase 1)
export { MessageRouter, MessageRoutingError, } from './message-router.js';
// Typed turn-outcome error (Issue #4649 review ①: thrown by ChatAgent when
// a newer message supersedes the awaited turn; consumers branch on instanceof)
export { TurnSupersededError } from './turn-superseded-error.js';
