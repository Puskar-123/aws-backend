const mongoose = require("mongoose");
const { Schema } = mongoose;

const IdentityRef = { type: Schema.Types.ObjectId, ref: "User" };

const LabelSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  color: { type: String, default: "6e7681", match: /^[0-9a-fA-F]{6}$/ },
}, { _id: false });

const CommentSchema = new Schema({
  author: { ...IdentityRef, required: true },
  body: { type: String, required: true, trim: true, maxlength: 10000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const RelevantFileSchema=new Schema({path:{type:String,required:true,maxlength:1000},reason:{type:String,default:"",maxlength:1000},relevance:{type:String,enum:["required","likely","possible","avoid"],default:"likely"}},{_id:false});
const CompletionCheckSchema=new Schema({key:{type:String,required:true,maxlength:100},label:{type:String,required:true,maxlength:300},checkType:{type:String,required:true,maxlength:80},configuration:{type:Schema.Types.Mixed,default:{}},required:{type:Boolean,default:true},weight:{type:Number,default:1,min:0,max:100}},{_id:false});

const IssueSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  // Legacy documents predate repository-scoped numbers. New writes always set it.
  number: { type: Number, default: null },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, default: "", maxlength: 20000 },
  description: { type: String, default: "", maxlength: 20000 },
  author: { ...IdentityRef, default: null },
  owner: { type: Schema.Types.Mixed, default: null },
  user: { type: Schema.Types.Mixed, default: null },
  status: { type: String, enum: ["open", "closed"], default: "open", index: true },
  state: { type: String, default: null },
  open: { type: Boolean, default: undefined },
  closed: { type: Boolean, default: undefined },
  labels: { type: [LabelSchema], default: [] },
  assignees: { type: [{ ...IdentityRef }], default: [] },
  priority: { type: String, enum: ["low", "medium", "high", "critical", "none"], default: "none" },
  linkedPullRequests: { type: [{ type: Schema.Types.ObjectId, ref: "PullRequest" }], default: [] },
  closedBy: { ...IdentityRef, default: null },
  closedAt: { type: Date, default: null },
  comments: { type: [CommentSchema], default: [] },
  contributionGuide:{enabled:{type:Boolean,default:false},difficulty:{type:String,enum:["beginner","intermediate","advanced"],default:"beginner"},estimatedMinutes:{type:Number,default:null,min:5,max:2880},requiredSkills:{type:[String],default:[]},optionalSkills:{type:[String],default:[]},taskType:{type:String,default:"",maxlength:100},projectArea:{type:String,default:"",maxlength:100},beginnerFriendly:{type:Boolean,default:false},relevantFiles:{type:[RelevantFileSchema],default:[]},completionChecks:{type:[CompletionCheckSchema],default:[]},maintainerNotes:{type:String,default:"",maxlength:5000},configuredBy:{...IdentityRef,default:null},configuredAt:{type:Date,default:null}},
}, { timestamps: true });

IssueSchema.index(
  { repository: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: "number" } } },
);
IssueSchema.index({ repository: 1, status: 1, updatedAt: -1 });
IssueSchema.index({ repository: 1, closedAt: -1 });
IssueSchema.index({ repository: 1, "labels.name": 1, priority: 1 });

module.exports = mongoose.model("Issue", IssueSchema);
