import { BaseModel, ClientModel, Property, EphemeralProperty, LoadStrategy } from "sync-engine";
import { dateSerializer, dateDeserializer } from "./serializers";

@ClientModel({ name: "User", loadStrategy: LoadStrategy.Eager })
export class User extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public name = "";

  @Property()
  public email = "";

  @EphemeralProperty()
  public lastUserInteraction: Date | null = null;
}
