class CreateRunSteps < ActiveRecord::Migration[8.1]
  def change
    # Без этого пользователь видит только молчание на несколько минут.
    # Половина воспринимаемого качества продукта — здесь.
    create_table :run_steps do |t|
      t.references :agent_run, null: false, foreign_key: true
      t.string   :kind,  null: false        # tool_use | tool_result | thinking
      t.string   :label
      t.jsonb    :payload, null: false, default: {}
      t.datetime :created_at, null: false
    end
    add_index :run_steps, [ :agent_run_id, :created_at ]
  end
end
