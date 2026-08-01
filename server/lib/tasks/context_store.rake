namespace :workspace do
  desc "Give a workspace its own account in the context store — WORKSPACE=slug OPENVIKING_ROOT_KEY=…"
  task provision: :environment do
    slug = ENV.fetch("WORKSPACE")
    url = ENV.fetch("OPENVIKING_URL")
    root = ENV.fetch("OPENVIKING_ROOT_KEY")

    workspace = Workspace.find_by!(slug:)
    Memory::Provision.new(url:, root_key: root).call(workspace)
    puts "#{slug} now has its own account at #{workspace.openviking_url}."
  end
end
