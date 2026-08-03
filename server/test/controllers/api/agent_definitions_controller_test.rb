require "test_helper"

class Api::V1::AgentDefinitionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @workspace = in_a_workspace
    @admin = user(name: "Alice")
    @admin.workspace_memberships.sole.update!(role: "admin")
    @member = user(name: "Bob")
    @json = { "Content-Type" => "application/json" }
  end

  test "every member reads the personas the team agreed on" do
    AgentDefinition.create!(workspace: @workspace, name: "crm", command: "opencode",
                            args: [ "acp" ], instruction: "Keep the CRM current.",
                            model: "anthropic/claude-sonnet-5")

    get api_v1_agent_definitions_path, headers: auth(@member)

    assert_response :success
    assert_equal [ { "name" => "crm", "command" => "opencode", "args" => [ "acp" ],
                     "instruction" => "Keep the CRM current.",
                     "model" => "anthropic/claude-sonnet-5" } ], response.parsed_body
  end

  test "sharing a persona is an admin's act, and sharing it again corrects it" do
    post api_v1_agent_definitions_path,
         params: { name: "crm", command: "opencode", args: [ "acp" ] }.to_json,
         headers: auth(@admin).merge(@json)
    assert_response :created

    post api_v1_agent_definitions_path,
         params: { name: "crm", command: "codex-acp", instruction: "Answer customers." }.to_json,
         headers: auth(@admin).merge(@json)
    assert_response :created

    definitions = AgentDefinition.where(workspace: @workspace)
    assert_equal 1, definitions.count, "the name is the identity — no second @crm"
    assert_equal "codex-acp", definitions.sole.command
    assert_equal "Answer customers.", definitions.sole.instruction
  end

  test "a member who is not an admin is refused, and told why" do
    post api_v1_agent_definitions_path,
         params: { name: "crm", command: "opencode" }.to_json,
         headers: auth(@member).merge(@json)

    assert_response :forbidden
    assert_equal 0, AgentDefinition.count
  end

  test "a persona never carries a credential, whatever the request smuggles" do
    post api_v1_agent_definitions_path,
         params: { name: "crm", command: "opencode", api_key: "sk-nope",
                   args: [ "acp" ] }.to_json,
         headers: auth(@admin).merge(@json)

    assert_response :created
    refute_includes response.parsed_body.keys, "api_key"
    refute_includes AgentDefinition.column_names, "api_key",
           "there is no credential column by construction (Article P2)"
  end

  test "removing a persona is by name, and admin's too" do
    AgentDefinition.create!(workspace: @workspace, name: "crm", command: "opencode")

    delete api_v1_agent_definition_path("crm"), headers: auth(@member)
    assert_response :forbidden

    delete api_v1_agent_definition_path("crm"), headers: auth(@admin)
    assert_response :no_content
    assert_equal 0, AgentDefinition.count
  end

  test "another workspace's personas are not this one's" do
    elsewhere = workspace
    Workspace.entered(elsewhere) do
      AgentDefinition.create!(workspace: elsewhere, name: "theirs", command: "opencode")
    end

    get api_v1_agent_definitions_path, headers: auth(@member)

    assert_response :success
    assert_empty response.parsed_body, "a persona belongs to the room that agreed on it"
  end

  test "a name @ cannot reach is not a persona" do
    post api_v1_agent_definitions_path,
         params: { name: "not a name", command: "opencode" }.to_json,
         headers: auth(@admin).merge(@json)

    assert_response :unprocessable_content
  end
end
