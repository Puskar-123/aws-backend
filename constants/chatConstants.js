const CONVERSATION_TYPES=Object.freeze(["direct","repository","issue","pull_request","mentor"]);
const MESSAGE_TYPES=Object.freeze(["text","code","file","system"]);
const REACTIONS=Object.freeze(["👍","👎","❤️","🎉","🚀","👀","✅","❌"]);
const LIMITS=Object.freeze({text:10000,code:20000,attachments:5,attachmentBytes:10*1024*1024,search:100,title:120,mentorRequest:2000,report:2000});
const createDirectKey=(a,b)=>[String(a),String(b)].sort().join(":");
module.exports={CONVERSATION_TYPES,MESSAGE_TYPES,REACTIONS,LIMITS,createDirectKey};
