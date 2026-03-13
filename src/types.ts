import type { CaldavUser } from "./auth/auth.js";

export type AppBindings = {
	Bindings: CloudflareBindings;
	Variables: {
		user: CaldavUser;
	};
};
