module Api
  module V1
    # The workspace's agent personas (#233). Members read them — every client
    # merges them under its person's own definitions at boot, local winning on
    # a name, the way the baseline three are appended and never imposed.
    # Writing one is an admin's act, like inviting: a description the whole
    # team runs under is not something any one member quietly rewrites.
    class AgentDefinitionsController < BaseController
      before_action :require_workspace_admin, except: :index

      def index
        render json: current_workspace.agent_definitions.order(:name).map { |d| serialize(d) }
      end

      # An upsert by name, because the name is the identity: sharing @crm again
      # is correcting @crm, not making a second one.
      def create
        definition = current_workspace.agent_definitions
                                      .find_or_initialize_by(name: params.require(:name))
        definition.update!(command: params.require(:command),
                           args: Array(params[:args]),
                           instruction: params[:instruction].presence,
                           model: params[:model].presence)
        Activity.log(actor: current_user, action: "agent_definition.shared", subject: definition)
        render json: serialize(definition), status: :created
      end

      def destroy
        definition = current_workspace.agent_definitions.find_by!(name: params[:name])
        definition.destroy!
        Activity.log(actor: current_user, action: "agent_definition.removed", subject: nil)
        head :no_content
      end

      private

      def serialize(d) = d.slice(:name, :command, :args, :instruction, :model)
    end
  end
end
