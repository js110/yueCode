import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export class EarendilAnnouncementComponent extends Container {
	constructor() {
		super();

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Welcome to Yue")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}
