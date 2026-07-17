const HEALTH_SCORE_VERSION = 1;
const HEALTH_WEIGHTS = Object.freeze({ documentation: 15, automatedTests: 20, maintenance: 10, issueManagement: 10, security: 15, codeQuality: 15, buildDeployment: 5, beginnerFriendliness: 10 });
const HEALTH_RANGES = Object.freeze({ "30d": 30, "90d": 90, "180d": 180 });
const HEALTH_LEVELS = Object.freeze([{ min: 90, status: "excellent" }, { min: 75, status: "good" }, { min: 60, status: "needs_improvement" }, { min: 40, status: "poor" }, { min: 0, status: "critical" }]);
module.exports = { HEALTH_SCORE_VERSION, HEALTH_WEIGHTS, HEALTH_RANGES, HEALTH_LEVELS };
