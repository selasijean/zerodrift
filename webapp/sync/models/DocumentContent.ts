import { BaseModel, ClientModel, Property, Reference, LoadStrategy } from "sync-engine";
import type { Issue } from "./Issue";

@ClientModel({ name: "DocumentContent", loadStrategy: LoadStrategy.Partial })
export class DocumentContent extends BaseModel {
  @Property()
  public content = "";

  @Property({ indexed: true })
  public issueId = "";

  @Reference("Issue")
  public issue: Issue;
}
